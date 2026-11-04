// POST /api/audit  { "handle": "celo" }
// The agent buys the data it needs (profile, recent posts, follower sample, AI verdict),
// pays for each call in stablecoins on Celo through buy, and returns the audit plus receipts.
import { SERVICES, paidCall, aiVerdict, config, agentAccount } from '../lib/agent.js';
import { readProfile, readTweets, readFollowers, analyze, templateVerdict } from '../lib/analyze.js';


const cache = new Map(); // handle -> { at, result }
const CACHE_MS = 60 * 60 * 1000;
const hits = new Map(); // ip -> [timestamps]
const PER_IP_PER_HOUR = Number(process.env.PER_IP_PER_HOUR || 6);

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= PER_IP_PER_HOUR) return true;
  list.push(now);
  hits.set(ip, list);
  return false;
}

function cleanHandle(h) {
  let s = String(h || '').trim();
  const m = s.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s : null;
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'GET' && req.query && req.query.handle) {
    req.body = { handle: req.query.handle, debug: req.query.debug === '1', fresh: req.query.fresh === '1' };
    req.method = 'POST';
    // Link-style GETs always answer 200 so the status is readable from any client.
    const realStatus = res.status.bind(res);
    res.status = (code) => { res.setHeader('x-audit-status', String(code)); return realStatus(200); };
  }
  if (req.method === 'GET') {
    const cfg = config();
    const addr = agentAccount().address;
    return res.status(200).json({
      agent: 'TrueReach',
      network: cfg.network,
      sandbox: cfg.sandbox,
      token: cfg.token,
      wallet: cfg.sandbox ? null : addr,
      walletUrl: cfg.sandbox ? null : cfg.addressExplorer + addr,
      services: Object.values(SERVICES).map((s) => ({ label: s.label, url: s.url, maxUsd: s.max })),
    });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body || {};
  const handle = cleanHandle(body.handle);
  if (!handle) return res.status(400).json({ error: 'Enter a valid X handle, like @celo' });

  const key = handle.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && !body.fresh) {
    const { debug, ...rest } = hit.result;
    return res.status(200).json({ ...rest, cached: true, debug: body.debug ? debug : undefined });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return res.status(429).json({ error: 'Slow down — a few audits per hour per visitor, because every audit is paid for onchain.' });

  const receipts = [];
  const cfg = config();
  const started = Date.now();
  try {
    // 1) Profile first: if the account doesn't exist, stop before spending more.
    const rawProfile = await paidCall(SERVICES.profile, SERVICES.profile.body(handle), receipts);
    const profile = readProfile(rawProfile);
    if (!profile.handle) profile.handle = handle;
    if (profile.followers === null && !profile.name) {
      return res.status(404).json({ error: `Couldn't find @${handle} on X.`, receipts, debug: body.debug ? rawProfile : undefined });
    }

    // 2) Posts and follower sample in parallel.
    const [rawTweets, rawFollowers] = await Promise.allSettled([
      paidCall(SERVICES.tweets, SERVICES.tweets.body(handle), receipts),
      paidCall(SERVICES.followers, SERVICES.followers.body(handle), receipts),
    ]);
    const tweets = rawTweets.status === 'fulfilled' ? readTweets(rawTweets.value, profile.handle) : [];
    const followers = rawFollowers.status === 'fulfilled' ? readFollowers(rawFollowers.value) : [];
    const warnings = [];
    if (rawTweets.status === 'rejected') warnings.push('Recent posts could not be loaded: ' + rawTweets.reason.message);
    if (rawFollowers.status === 'rejected') warnings.push('Follower sample could not be loaded: ' + rawFollowers.reason.message);

    const analysis = analyze({ profile, tweets, followers });

    // 3) AI verdict, bought per completion. The partner LLM route is mainnet only.
    let verdict = null;
    let verdictSource = 'rules';
    if (!cfg.sandbox) {
      try {
        verdict = await aiVerdict(profile, analysis, receipts);
        if (verdict) verdictSource = 'ai';
      } catch (e) {
        warnings.push('AI verdict unavailable, using rule-based summary: ' + e.message);
      }
    }
    if (!verdict) verdict = templateVerdict(profile, analysis);

    const result = {
      handle: profile.handle,
      profile,
      ...analysis,
      verdict,
      verdictSource,
      receipts,
      totalPaidUsd: Math.round(receipts.reduce((a, r) => a + r.amountUsd, 0) * 1e6) / 1e6,
      network: cfg.network,
      sandbox: cfg.sandbox,
      warnings,
      tookMs: Date.now() - started,
      auditedAt: new Date().toISOString(),
    };
    {
      const firstArr = (raw) => {
        const arrs = [];
        const walk = (v, d) => { if (!v || typeof v !== 'object' || d > 6) return; if (Array.isArray(v)) { if (v.length && typeof v[0] === 'object') arrs.push(v); v.forEach((x) => walk(x, d + 1)); } else Object.values(v).forEach((x) => walk(x, d + 1)); };
        walk(raw, 0);
        arrs.sort((a, b) => b.length - a.length);
        return arrs[0] ? { length: arrs[0].length, first: arrs[0][0] } : null;
      };
      result.debug = { tweetSample: firstArr(rawTweets.value), followerSample: firstArr(rawFollowers.value) };
    }
    cache.set(key, { at: Date.now(), result });
    console.log(JSON.stringify({ evt: 'audit', handle: profile.handle, score: analysis.score, paid: result.totalPaidUsd, tx: receipts.map((r) => r.txHash) }));
    return res.status(200).json(result);
  } catch (e) {
    console.error('audit failed', handle, e.message, e.detail || '');
    return res.status(502).json({ error: 'The audit could not finish: ' + e.message, detail: e.detail, receipts });
  }
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}
