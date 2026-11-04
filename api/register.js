// GET /api/register — one-time ERC-8004 identity registration for the agent wallet on Celo mainnet.
// Safe to leave public: it only ever registers THIS agent, and does nothing once the wallet already
// holds an identity (it just reports the existing agentId). Gas is paid in USDC via Celo's fee adapter.
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const USDC_FEE_ADAPTER = '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B';
const abi = parseAbi([
  'function register(string agentURI) returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  let key = process.env.AGENT_PRIVATE_KEY;
  if (!key) return res.status(400).json({ error: 'No agent wallet configured yet (AGENT_PRIVATE_KEY is not set).' });
  if (!key.startsWith('0x')) key = '0x' + key;
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: celo, transport: http() });
  const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const agentURI = process.env.AGENT_CARD_URL || `${origin}/agent.json`;

  try {
    const owned = await pub.readContract({ address: REGISTRY, abi, functionName: 'balanceOf', args: [account.address] });
    if (owned > 0n) {
      // Find the existing id from past mint events to this wallet.
      const logs = await pub.getLogs({ address: REGISTRY, event: abi[2], args: { to: account.address }, fromBlock: 'earliest' }).catch(() => []);
      const id = logs.length ? logs[logs.length - 1].args.tokenId.toString() : null;
      return res.status(200).json({ alreadyRegistered: true, agentId: id, wallet: account.address, registry: `eip155:42220:${REGISTRY}`, scan: 'https://8004scan.io' });
    }
    if (req.query.go !== '1') {
      return res.status(200).json({ ready: true, wallet: account.address, agentURI, note: 'Call /api/register?go=1 to register this agent on Celo mainnet (gas paid in USDC).' });
    }
    const wallet = createWalletClient({ account, chain: celo, transport: http() });
    const hash = await wallet.writeContract({ address: REGISTRY, abi, functionName: 'register', args: [agentURI], feeCurrency: USDC_FEE_ADAPTER });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 45000 });
    const ev = parseEventLogs({ abi, logs: receipt.logs, eventName: 'Transfer' }).find((l) => l.args.to.toLowerCase() === account.address.toLowerCase());
    return res.status(200).json({
      registered: receipt.status === 'success',
      agentId: ev ? ev.args.tokenId.toString() : null,
      txHash: hash,
      txUrl: `https://celoscan.io/tx/${hash}`,
      wallet: account.address,
      agentURI,
      registry: `eip155:42220:${REGISTRY}`,
    });
  } catch (e) {
    return res.status(500).json({ error: e.shortMessage || e.message });
  }
}
