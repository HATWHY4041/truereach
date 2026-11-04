// The paying side of the agent. Every outside service it uses is bought per call
// through buy (x402 on Celo): the gateway answers 402 with a price, we sign an
// EIP-3009 stablecoin authorization, and the call is retried with payment attached.
import { x402, getTokenBalance } from '@celo/buy-core';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';

const GATEWAY = 'https://gateway.usebuy.ai';

export const SERVICES = {
  profile: {
    label: 'X profile · TikHub via buy',
    url: `${GATEWAY}/v1/social/x/tools/tikhub-api-v1-twitter-web-fetch-user-profile`,
    body: (handle) => ({ queryParams: { screen_name: handle } }),
    max: 0.006,
  },
  tweets: {
    label: 'X recent posts · TikHub via buy',
    url: `${GATEWAY}/v1/social/x/tools/tikhub-api-v1-twitter-web-fetch-user-post-tweet`,
    body: (handle) => ({ queryParams: { screen_name: handle } }),
    max: 0.006,
  },
  followers: {
    label: 'X follower sample · TikHub via buy',
    url: `${GATEWAY}/v1/social/x/tools/tikhub-api-v1-twitter-web-fetch-user-followers`,
    body: (handle) => ({ queryParams: { screen_name: handle } }),
    max: 0.006,
  },
  llm: {
    label: 'AI verdict · Cencori inference via buy',
    url: `${GATEWAY}/cencori/v1/chat/completions`,
    max: 0.011,
  },
};

export function config() {
  const sandbox = process.env.BUY_NETWORK === 'celo-sepolia' || !process.env.AGENT_PRIVATE_KEY;
  return {
    sandbox,
    network: sandbox ? 'celo-sepolia' : 'celo',
    token: (process.env.BUY_TOKEN || 'USDC').toUpperCase(),
    explorer: sandbox ? 'https://celo-sepolia.blockscout.com/tx/' : 'https://celoscan.io/tx/',
    addressExplorer: sandbox ? 'https://celo-sepolia.blockscout.com/address/' : 'https://celoscan.io/address/',
  };
}

let cachedAccount;
// Mainnet: the agent's own wallet (private key set by the owner as a Vercel env var).
// Sandbox: a throwaway key per cold start, funded with valueless test USDC by the gateway faucet.
export function agentAccount() {
  if (cachedAccount) return cachedAccount;
  const { sandbox } = config();
  let key = process.env.AGENT_PRIVATE_KEY;
  if (sandbox) key = generatePrivateKey();
  if (key && !key.startsWith('0x')) key = '0x' + key;
  cachedAccount = privateKeyToAccount(key);
  return cachedAccount;
}

const toUnits = (usd) => BigInt(Math.round(usd * 1e6)); // all three stablecoins use 6 decimals

export async function paidCall(service, body, receipts) {
  const cfg = config();
  const account = agentAccount();
  const ctx = {
    account,
    network: cfg.network,
    preferredToken: cfg.token,
    readBalance: getTokenBalance,
  };
  if (cfg.sandbox) {
    ctx.topUp = async (info) => {
      const r = await x402.fundSandboxIfShort({ ...info, address: info.owner, read: getTokenBalance });
      return x402.sandboxFaucetNote(r);
    };
  }
  let paid;
  const started = Date.now();
  const res = await x402.payingFetch(ctx, service.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    maxAmount: toUnits(service.max),
    onPayment: (info) => { paid = info; },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (paid) {
    receipts.push({
      service: service.label,
      endpoint: service.url.replace(GATEWAY, ''),
      amountUsd: Number(paid.amount) / 1e6,
      token: cfg.token,
      txHash: paid.txHash ?? null,
      explorerUrl: paid.txHash ? cfg.explorer + paid.txHash : null,
      outcome: paid.outcome,
      ms: Date.now() - started,
    });
  }
  if (!res.ok) {
    const err = new Error(`${service.label} answered HTTP ${res.status}`);
    err.status = res.status;
    err.detail = typeof json === 'object' ? JSON.stringify(json).slice(0, 400) : String(text).slice(0, 400);
    err.paid = Boolean(paid);
    throw err;
  }
  return json;
}

export async function aiVerdict(profile, analysis, receipts) {
  const facts = {
    account: { name: profile.name, handle: profile.handle, bio: profile.bio, verified: profile.verified },
    score: analysis.score,
    grade: analysis.grade,
    metrics: analysis.metrics,
    redFlags: analysis.redFlags,
    greenFlags: analysis.greenFlags,
    topPosts: analysis.topPosts.map((t) => ({ text: t.text.slice(0, 200), likes: t.likes, retweets: t.retweets, replies: t.replies, views: t.views })),
  };
  const json = await paidCall(SERVICES.llm, {
    model: 'maximo-atlas-1.3',
    max_tokens: 320,
    messages: [
      {
        role: 'system',
        content:
          'You are TrueReach, an analyst who audits crypto projects\' X (Twitter) accounts for investors, KOL managers and marketers. ' +
          'Using ONLY the JSON facts given, write a plain-English verdict in at most 90 words: is this audience real, ' +
          'is engagement organic, and one concrete recommendation. No hype, no financial advice, no markdown headings.',
      },
      { role: 'user', content: JSON.stringify(facts) },
    ],
  }, receipts);
  const text = json?.choices?.[0]?.message?.content ?? json?.output_text ?? null;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}
