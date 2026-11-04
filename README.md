# TrueReach — is that crypto project's X audience real?

TrueReach is an AI agent that audits any X (Twitter) account — usually a crypto project or a KOL — and tells you whether its audience and engagement are real. It **buys every piece of data it needs, per request, in stablecoins on Celo** through [buy](https://usebuy.ai) (x402). No API keys, no subscriptions.

Built for the Celo **Agents on Open Rails** hackathon — **Build with buy** track.

## The problem

Crypto marketing runs on X, and X numbers are easy to fake. Teams pay KOLs, investors judge traction, and communities pick projects by follower counts that are often bought or botted. Checking an account properly takes data most people can't get without paid API plans.

## What it does

Enter a handle → the agent:

| Step | Paid service (via buy) | Price |
|---|---|---|
| 1. Profile (followers, following, age, verified) | TikHub X profile | $0.005 |
| 2. Recent posts (likes, reposts, replies, views) | TikHub X user posts | $0.005 |
| 3. Follower sample | TikHub X followers | $0.005 |
| 4. Plain-English verdict | Cencori LLM inference | $0.01 |

≈ **$0.025 per audit**, paid by the agent's wallet, settled on Celo mainnet. The user pays nothing and needs no wallet.

The report includes a 0–100 **TrueReach score** (engagement, reach, real audience, activity), red flags and good signs, top posts, example suspicious followers, and a **receipts table linking every paid call to its Celo transaction**.

### How the score works

- **Engagement** — median (likes + reposts + replies + quotes) per original post ÷ followers, against a benchmark that scales with account size.
- **Reach** — median views per post ÷ followers.
- **Real audience** — share of the follower sample with 2+ bot signals: no photo, empty bio, never posted, follows many/followed by none, account < 90 days old, auto-generated handle.
- **Activity** — recency and cadence of original posts.

## How payment works

`lib/agent.js` uses `payingFetch` from `@celo/buy-core`: request → `402 Payment Required` with a quote → the agent signs an EIP-3009 stablecoin authorization locally (with a per-call spending cap) → retries with `X-PAYMENT` → the gateway settles on Celo and returns the data. The settlement tx hash is captured from `X-PAYMENT-RESPONSE` and shown to the user.

Safety: a hard `maxAmount` per call, profile is checked first so a non-existent handle costs one call only, 1-hour cache per handle, and a per-visitor hourly limit.

## Run it

Deployed on Vercel (static `index.html` + `api/audit.js` serverless function).

Environment variables:

- `AGENT_PRIVATE_KEY` — the agent wallet's key (a dedicated low-balance wallet funded with USDC, USD₮ or USA₮ on Celo). If unset, the app runs in **test mode** on Celo Sepolia with free test USDC from the buy faucet.
- `BUY_TOKEN` — `USDC` (default), `USDT` or `USAT`.
- `PER_IP_PER_HOUR` — audits per visitor per hour (default 6).

Local logic test: `npm install && npm test`.

## Hackathon details

- Track: Build with buy
- Services used: buy gateway → TikHub X data (profile, posts, followers) and Cencori inference
- Agent identity: ERC-8004 (see submission)
- Network: Celo mainnet
