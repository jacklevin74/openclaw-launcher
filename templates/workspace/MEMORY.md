# MEMORY.md — Long-Term Knowledge

Curated memory. Safe to reference in any context. No credentials here.

---

## Who I Am
- **{{AGENT_NAME}}** — AI agent with personality, rooted in the X1/Solana ecosystem
- General-purpose conversationalist with deep crypto expertise
- Direct, opinionated, curious. Not a generic chatbot.

## X1 Blockchain
- SVM-compatible L1 with Tachyon validator client
- Zero-cost votes (40x cheaper than Solana for validators)
- Dynamic base fees (congestion-responsive, 48M CU per block)
- Dynamic thread scaling (uses all CPU cores, not just 4 like Solana)
- Performance-based leader selection (not just stake weight)
- O(1) consensus via subcommittee voting (HotStuff2)
- Native token: XNT
- Mainnet RPC: `https://rpc.mainnet.x1.xyz`
- DEX: XDEX (`https://xdex.xyz`)
- Explorer: `https://explorer.x1.xyz/`
- See `X1.md` for full technical details

## X1 Validator Operations
- Hardware: 12+ cores, 192GB+ RAM, 4TB NVMe, bare metal only
- No minimum XNT to run a validator
- Rewards: inflation voting rewards + commission + block production + bootstrap bonus
- Bootstrap bonus: extra 16% for meeting performance criteria (97%+ vote credits, <=10% skip rate)
- Tachyon client (replaces solana-validator): `tachyon-validator`
- OpenClaw launcher manages AI agent instances per validator wallet

## Solana Ecosystem Knowledge

### Key Protocols
- **Jupiter** — DEX aggregator, limit orders, DCA, perps
- **Raydium** — AMM + CLMM, concentrated liquidity
- **Orca** — Whirlpools (CLMM), developer-friendly
- **Marinade** — Liquid staking (mSOL), validator delegation
- **Jito** — MEV protocol, liquid staking (jitoSOL)
- **Tensor / Magic Eden** — NFT marketplaces
- **Helius** — RPC infrastructure, DAS API, webhooks
- **Phantom / Backpack** — Leading wallets

### Token Standards
- SPL Token — Original standard
- Token-2022 — Transfer hooks, confidential transfers, metadata extensions
- Metaplex — NFT standards (Token Metadata, Core, Candy Machine)
- Compressed NFTs — Merkle tree based, 1000x cheaper minting

## XDEX
- Decentralized exchange on X1 and Solana
- API: `https://api.xdex.xyz`
- Pools, swap quotes, wallet balances, charts, sentiment, boosts
- See `XDEX.md` for full API reference

## Lessons
- (To be populated as I interact with the community)

## People
- (To be populated as I meet community members)

---

*Update this file regularly with distilled insights from daily interactions.*
