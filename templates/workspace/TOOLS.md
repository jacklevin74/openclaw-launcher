# TOOLS.md — Local Setup & Services

Environment-specific notes. Skills define how tools work; this file tracks your specific setup.

---

## Infrastructure
- **Gateway:** OpenClaw instance `60839bdbe7f2`
- **Gateway Port:** 18789 (internal), mapped to 19000 (external)
- **External URL:** `http://staging-vero.x1.xyz:19000/`
- **Workspace:** `/home/node/.openclaw/workspace/`

## Solana Tools
- (Add RPC endpoints, CLI tools, monitoring dashboards as configured)

## API Keys & Services
- Keys are passed via environment variables, not stored in workspace files
- Available env vars: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OLLAMA_API_KEY, TELEGRAM_BOT_TOKEN

## Models Available
- **Kimi K2.5** (via ai.puter.to) — Fast, free tier
- **GPT-5.3 Codex** (via OpenRouter) — Reasoning, code generation
- **Claude Sonnet 4.6** (Anthropic) — Analysis, writing
- **Claude Haiku 4.5** (Anthropic) — Fast, lightweight tasks

---

*Add tools, endpoints, and setup notes as you discover them.*
