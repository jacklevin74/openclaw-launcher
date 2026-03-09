# X1 Blockchain Knowledge

## What is X1?

X1 is a high-performance SVM (Solana Virtual Machine) compatible blockchain focused on decentralization, zero-cost voting, and dynamic fee scaling. It runs the **Tachyon** validator client (fork of Solana's validator with significant improvements).

## Constitution

Five foundational principles:
1. **Freedom of Individual Agency** — Right to communicate, transact, and interact freely without centralized control
2. **Self-Custody and Ownership** — Complete dominion over digital holdings and personal data
3. **Privacy as a Choice** — Encryption and cryptographic methods for financial privacy
4. **Transparency via Code** — Open-source, verifiable smart contracts; trust embedded in technology
5. **Evolution Through Innovation** — Continuous advancement of encryption, distributed systems, and blockchain tech

## Key Technical Innovations

### Zero-Cost Votes
- Validators on Solana pay ~$8,600/month in vote fees at $250/SOL (94% of expenses)
- X1 eliminates vote costs entirely — **40x cost efficiency improvement**
- Lower entry barriers = more validators = better decentralization
- Spam prevention still works because voting requires stake (attacking consensus needs 33% of total stake)

### Dynamic Base Fees
- Congestion-responsive fee model: fees scale with network demand
- Block capacity: 48M Compute Units per block
- Combines parallel execution (like Solana) with global base fee enforcement (like Ethereum)
- Low demand = cheap transactions; high demand = higher fees + more validator revenue + deflationary pressure

### SVM Capacity Scaling
- Solana limits banking threads to 4 regardless of hardware
- X1 dynamically adjusts banking threads based on CPU core count
- A 32-core processor uses up to 32 threads instead of just 4
- Better hardware utilization, reduced latency, higher throughput

### Performance-Based Leader Selection
- Solana selects leaders by stake weight only, ignoring performance (some validators skip 50%+ of slots)
- X1 uses multi-factor scoring: stake weight + historical performance + VRF randomness
- Poor performers get excluded from leadership; combats centralization

### Scaling Through Reductionism
- Traditional consensus: O(n²) communication overhead
- Avalanche: O(log(n)) via gossip protocols
- X1: O(1) constant time via subcommittee voting (from HotStuff2 consensus)
- Allows indefinite number of nodes with fast, efficient consensus

### Homomorphic Encryption (Roadmap)
- Computations on encrypted data without decryption
- Linear bandwidth scaling, decryption in tens of milliseconds
- Use cases: encrypted limit orders, MEV prevention, private governance, censorship resistance

## Network Details

| Parameter | Value |
|-----------|-------|
| Native token | XNT |
| Mainnet RPC | `https://rpc.mainnet.x1.xyz` |
| Testnet RPC | `https://rpc.testnet.x1.xyz` |
| Explorer | `https://explorer.x1.xyz/` |
| Validator client | Tachyon (current: v2.0.21) |
| SVM compatible | Yes — fully Solana-compatible |
| Validator monitor | `http://x1val.online/` |
| Testnet faucet | `https://faucet.testnet.x1.xyz/` |
| DEX | XDEX (`https://xdex.xyz`) |

## Tachyon Validator Client

Tachyon is X1's custom validator client (replaces Solana's `solana-validator`). Key commands:

| Command | Purpose |
|---------|---------|
| `tachyon-validator` | Start/manage validator |
| `tachyon-validator exit -f` | Gracefully stop validator |
| `tachyon-validator --ledger ledger/ monitor` | Watch ledger progress |
| `solana validators` | List active validators |
| `solana block-production` | Check block production stats |
| `solana leader-schedule` | View leader schedule |
| `solana catchup --our-localhost` | Check sync status |
| `solana gossip` | View gossip network |
| `solana epoch-info` | Current epoch details |
| `solana stake-history` | Previous 10 epochs stake data |

## Validator Operations

### Hardware Requirements
- **CPU:** 12+ cores / 24+ threads, 3GHz+ base clock
- **RAM:** 192 GB minimum
- **Storage:** 4TB NVMe
- **Server:** Bare metal dedicated (not VPS)
- **No minimum XNT required** to run a validator

### Validator Rewards
1. **Voting rewards from inflation** — Credits earned per epoch, exchanged for inflation rewards. Schedule: starts at 8% annually, declines 15%/year toward 1.5% long-term
2. **Commission from delegators** — Typically 10% of delegation rewards
3. **Block production rewards** — Transaction fees from successfully produced blocks (confirmed by 67%+ of cluster)
4. **Bootstrap Bonus** — Extra rewards for early, performant validators

### Bootstrap Bonus Criteria
- Self-stake: 1,000–10,000 XNT (bonus-eligible range)
- Active validator status
- Max 10% commission
- Vote credits >= 97% of network average
- Skip rate <= 10% above network average
- Running majority-adopted Tachyon version
- Max 10 validators per individual/entity
- Performance bonus: extra 16% for meeting all criteria

### Staking Operations
```bash
# Delegate stake
solana delegate-stake stake.json vote.json

# Check stake status
solana stake-account stake.json

# Deactivate stake
solana deactivate-stake <STAKE_ACCOUNT_ADDRESS>

# Withdraw
solana withdraw-stake <STAKE_ACCOUNT_ADDRESS> <RECIPIENT> <AMOUNT>
```

**Important:** You cannot add to an ongoing stake. Either unstake (wait for epoch), then restake, or create a new stake account.

### Validator Registration
```bash
solana config set -k identity.json
solana validator-info publish "Validator Name" -w https://website.com -i https://icon-url.png -k identity.json
```

## Building on X1

X1 is fully SVM/Solana compatible. Use standard Solana tools:

### Development Stack
- **Anchor Framework** — Smart contract development
- **Solana CLI** — Network interaction
- **Metaplex** — Token and NFT creation (Token Metadata, Core, Candy Machine)
- **Rust + Cargo** — Program compilation

### Quick Start
```bash
# Install all dependencies
curl --proto '=https' --tlsv1.2 -sSfL https://raw.githubusercontent.com/solana-developers/solana-install/main/install.sh | bash

# Initialize Anchor project
anchor init my_project && cd my_project

# Configure for X1
solana config set -u https://rpc.testnet.x1.xyz

# Build and deploy
anchor build && anchor test
```

### Metaplex on X1
- **Token Metadata** — Standard for fungible/non-fungible tokens
- **Core** — Next-gen NFT standard with plugin system, lower rent costs
- **Candy Machine** — Lazy-minting NFT collections with 20+ configurable guards
- 880M+ assets minted, $9.8B total transaction value across ecosystem

### Wallet Setup (Backpack)
1. Install Backpack extension from backpack.app
2. Import private key from `cat id.json`
3. Enable developer mode
4. Set RPC to X1 mainnet: `https://rpc.mainnet.x1.xyz`

# XDEX API Interaction Skill

You are an expert at interacting with the XDEX decentralized exchange API. Use this skill whenever you need to query XDEX for token data, pool information, swap quotes, wallet balances, chart data, or any other XDEX platform functionality.

## Base URLs

| Environment | URL |
|---|---|
| Production | `https://api.xdex.xyz` |
| Development | `https://devapi.xdex.xyz` |

## Authentication

- **Public endpoints require no API key or authentication.**
- Wallet-based identity is used for write operations (boosts, token profiles, sentiment votes).
- No OAuth or bearer tokens are needed.

## Supported Networks

Pass the `network` query parameter as one of:

| Chain ID | Network Value |
|---|---|
| `x1` | `X1 Mainnet` |
| `solana` | `Solana Mainnet` |

## Token Address Note

The native wrapped SOL mint address `So11111111111111111111111111111111111111112` is mapped to the placeholder `111111111111111111111111111111111111111111` in API calls. Convert back when using results on-chain.

---

## Endpoints

### 1. Pool List

Fetch all liquidity pools on a given chain.

```
GET /api/xendex/pool/list?network={network}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "pool_address": "string",
      "token1_address": "string",
      "token2_address": "string",
      "token1_symbol": "string",
      "token2_symbol": "string",
      "token1_price": 0.0,
      "token2_price": 0.0,
      "tvl": 0.0,
      "lp_price": 0.0,
      "txns_24h": 0,
      "price_change_5m": 0.0,
      "price_change_1h": 0.0,
      "price_change_6h": 0.0,
      "price_change_24h": 0.0,
      "token1_volume_usd_24h": 0.0,
      "token2_volume_usd_24h": 0.0,
      "token1_total_trade_amount": "string (raw amount)",
      "token2_total_trade_amount": "string (raw amount)",
      "pool_info": {
        "mint0Decimals": 9,
        "mint1Decimals": 6,
        "lpMint": "string"
      },
      "lp_token_holder_count": 0,
      "createdAt": "ISO 8601 timestamp"
    }
  ]
}
```

**Example:**
```bash
curl "https://api.xdex.xyz/api/xendex/pool/list?network=X1%20Mainnet"
```

---

### 2. Single Pool Detail

Fetch details for a specific pool.

```
GET /api/xendex/pool/{poolAddress}?network={network}
```

**Response:** Same shape as a single item from the pool list.

---

### 3. Extended Pool Details

Get extended pool metrics (amounts, volume, transaction counts).

```
GET /api/xendex/pool/details?pool_address={address}&network={network}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "amount1": 0.0,
    "amount2": 0.0,
    "volume24h": 0.0,
    "txns7d": 0
  }
}
```

---

### 4. Pool Status (Aggregate Stats)

Get aggregate statistics across all pools.

```
GET /api/xendex/pool/status?network={network}
```

**Response:** Pool count, total holders, total transactions, and other aggregate stats.

---

### 5. Swap Quote

Get a price quote for a token swap.

```
GET /api/xendex/swap/quote?network={network}&token_in={address}&token_out={address}&token_in_amount={amount}&is_exact_amount_in=true
```

**Parameters:**
- `token_in` — Address of the input token
- `token_out` — Address of the output token
- `token_in_amount` — Amount in UI units (human-readable, e.g. `1.5`)
- `is_exact_amount_in` — Always `true`

**Response:**
```json
{
  "success": true,
  "data": {
    "outputAmount": 123.456,
    "rate": 82.304,
    "priceImpactPct": 0.05,
    "amm_config_address": "string (optional)"
  }
}
```

**Example:**
```bash
curl "https://api.xdex.xyz/api/xendex/swap/quote?network=X1%20Mainnet&token_in=So11...112&token_out=EPjF...abc&token_in_amount=1&is_exact_amount_in=true"
```

---

### 6. Swap Prepare

Prepare a signed swap transaction for on-chain execution.

```
POST /api/xendex/swap/prepare
Content-Type: application/json
```

**Request Body:**
```json
{
  "network": "X1 Mainnet",
  "wallet_address": "user_wallet_pubkey",
  "token_in": "input_token_address",
  "token_out": "output_token_address",
  "token_in_amount": 1.0
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "success": true,
    "transaction": "base64_serialized_transaction (string or string[])",
    "blockhash": "string",
    "lastValidBlockHeight": 123456789
  }
}
```

The returned transaction(s) must be signed by the user's wallet and submitted to the blockchain.

---

### 7. Wallet Token Balances

Get all token balances for a wallet.

```
GET /api/xendex/wallet/tokens?network={network}&wallet_address={address}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "tokens": [
      {
        "address": "string",
        "symbol": "string",
        "name": "string",
        "balance": "string or number",
        "decimals": 9,
        "uiAmount": 1.5,
        "logo": "url (optional)"
      }
    ]
  }
}
```

**Example:**
```bash
curl "https://api.xdex.xyz/api/xendex/wallet/tokens?network=X1%20Mainnet&wallet_address=YOUR_WALLET"
```

---

### 8. Token Price

Get the current USD price for a single token.

```
GET /api/token-price/price?network={network}&address={tokenAddress}
```

**Response:** Returns a numeric price value.

---

### 9. Chart / OHLCV Data

Get candlestick chart data for a token pair.

```
GET /api/xendex/chart/history?from_token={from}&to_token={to}&resolution={resolution}&time_from={unix_ts}&time_to={unix_ts}&network={network}
```

**Parameters:**
- `from_token` — Base token address
- `to_token` — Quote token address
- `resolution` — Candle size in minutes: `5`, `15`, `60`, `240`, `1440`
- `time_from` / `time_to` — UNIX timestamps (seconds)

**Response:**
```json
{
  "bars": [
    {
      "t": 1700000000,
      "o": 1.23,
      "h": 1.25,
      "l": 1.21,
      "c": 1.24,
      "v": 50000
    }
  ]
}
```

**Example (last 24h, 1-hour candles):**
```bash
curl "https://api.xdex.xyz/api/xendex/chart/history?from_token=TOKEN_A&to_token=TOKEN_B&resolution=60&time_from=1700000000&time_to=1700086400&network=X1%20Mainnet"
```

---

## Community / Social Endpoints

These endpoints are served by the XDEX frontend's Next.js API routes (same origin as the app).

### 10. Boost Orders

Promote tokens with visibility boosts.

```
GET  /api/boost                          — All boost orders
GET  /api/boost?active=true              — Active boosts only
GET  /api/boost?wallet={address}         — Orders by wallet
GET  /api/boost?token={address}          — Boosts for a token

POST /api/boost
Content-Type: application/json
Body: { "action": "create" | "activate" | "cancel", ...params }
```

---

### 11. Token Profiles

Custom banners and descriptions for tokens.

```
GET  /api/token-profile?token={address}  — Get token profile
POST /api/token-profile
Content-Type: application/json
Body: { "action": "update", "tokenAddress": "...", "walletAddress": "...", "banner": "url", "description": "text" }
```

---

### 12. Sentiment Voting

Community bullish/bearish sentiment.

```
GET  /api/sentiment?token={address}      — Get sentiment counts
POST /api/sentiment
Content-Type: application/json
Body: { "tokenAddress": "...", "sentiment": "bullish" | "bearish" }
```

Voter identity is derived from IP + User-Agent hash (anonymous, one vote per visitor).

---

## Usage Patterns

### Get all pools and find the highest TVL pool
```python
import requests

resp = requests.get("https://api.xdex.xyz/api/xendex/pool/list", params={"network": "X1 Mainnet"})
pools = resp.json()["data"]
top_pool = max(pools, key=lambda p: p["tvl"])
print(f"Top pool: {top_pool['token1_symbol']}/{top_pool['token2_symbol']} — TVL: ${top_pool['tvl']:,.2f}")
```

### Get a swap quote
```python
quote = requests.get("https://api.xdex.xyz/api/xendex/swap/quote", params={
    "network": "X1 Mainnet",
    "token_in": "So11111111111111111111111111111111111111112",
    "token_out": "TARGET_TOKEN_ADDRESS",
    "token_in_amount": "1",
    "is_exact_amount_in": "true"
}).json()

print(f"Output: {quote['data']['outputAmount']}, Impact: {quote['data']['priceImpactPct']}%")
```

### Get wallet balances
```python
tokens = requests.get("https://api.xdex.xyz/api/xendex/wallet/tokens", params={
    "network": "X1 Mainnet",
    "wallet_address": "YOUR_WALLET_PUBKEY"
}).json()

for t in tokens["data"]["tokens"]:
    print(f"{t['symbol']}: {t.get('uiAmount', t['balance'])}")
```

### Fetch 24h chart data
```python
import time

now = int(time.time())
yesterday = now - 86400

bars = requests.get("https://api.xdex.xyz/api/xendex/chart/history", params={
    "from_token": "TOKEN_A",
    "to_token": "TOKEN_B",
    "resolution": "60",
    "time_from": str(yesterday),
    "time_to": str(now),
    "network": "X1 Mainnet"
}).json()["bars"]

for bar in bars:
    print(f"Time: {bar['t']}, O: {bar['o']}, H: {bar['h']}, L: {bar['l']}, C: {bar['c']}, Vol: {bar['v']}")
```

---

## Error Handling

- All endpoints return `{ "success": false, "error": "message" }` on failure.
- Use timeouts of 8-15 seconds for most calls.
- Chart and price data should use `cache: 'no-store'` or equivalent to avoid stale data.
- The RPC proxy (`/api/rpc`) retries up to 2 times with exponential backoff.
- If many RPC calls fail consecutively (30+), back off for 30 seconds (circuit breaker).

## Rate Limits

No explicit rate limits documented, but be respectful:
- Poll pool lists no more than every 30 seconds.
- Batch RPC calls (supply/holders) in groups of 10-50.
- Individual token price lookups can be batched by fetching the full pool list instead.
