# TOOLS.md — Local Setup & Services

Environment-specific notes. Skills define how tools work; this file tracks your specific setup.

---

## Infrastructure
- **Runtime:** OpenClaw AI agent platform
- **Workspace:** `/home/node/.openclaw/workspace/`

## Solana Tools
- `solana` CLI available at `/usr/local/bin/solana`
- `solana-keygen` available at `/usr/local/bin/solana-keygen`
- Use these for on-chain queries, balance checks, and key management

## API Keys & Services
- Keys are passed via environment variables, not stored in workspace files
- Available providers configured in openclaw.json

## Models Available
- **Kimi K2.5** (via Ollama cloud) — Free, primary model
- **Claude Sonnet 4.6** (Anthropic) — Fallback, subagent model
- **Claude Haiku 4.5** (Anthropic) — Fast, lightweight tasks
- **GPT-5.3 Codex** (via OpenRouter) — Reasoning, code generation

## Skills
- **XDEX API** — See `XDEX.md` for full API reference. Query pools, swap quotes, wallet balances, charts, and community features on X1 and Solana networks.

---

*Add tools, endpoints, and setup notes as you discover them.*
