# TOOLS.md — Local Setup & Services

Environment-specific notes. Skills define how tools work; this file tracks your specific setup.

---

## Infrastructure
- **Runtime:** OpenClaw AI agent platform
- **Workspace:** `/home/node/.openclaw/workspace/`

## Tachyon / X1 Tools
- `tachyon-validator` — X1's validator client (replaces solana-validator)
- `solana` CLI available at `/usr/local/bin/solana` — used for staking, transfers, account queries
- `solana-keygen` available at `/usr/local/bin/solana-keygen` — keypair generation
- X1 Mainnet RPC: `https://rpc.mainnet.x1.xyz`
- X1 Testnet RPC: `https://rpc.testnet.x1.xyz`
- Explorer: `https://explorer.x1.xyz/`
- Validator monitor: `http://x1val.online/`

## API Keys & Services
- Keys are passed via environment variables, not stored in workspace files
- Available providers configured in openclaw.json

## Models Available
- **Kimi K2.5** (via Ollama cloud) — Free, primary model
- **Claude Sonnet 4.6** (Anthropic) — Fallback, subagent model
- **Claude Haiku 4.5** (Anthropic) — Fast, lightweight tasks
- **GPT-5.3 Codex** (via OpenRouter) — Reasoning, code generation

## Knowledge Files
- **X1.md** — X1 blockchain: architecture, Tachyon validator, staking, building, technical innovations
- **XDEX.md** — XDEX DEX API: pools, swaps, quotes, wallets, charts, community endpoints

---

*Add tools, endpoints, and setup notes as you discover them.*
