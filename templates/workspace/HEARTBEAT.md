# HEARTBEAT.md

## Periodic Tasks

### Config Sync (every few heartbeats)
- Check if `/home/jack/.openclaw/openclaw.json` changed
- If changed, copy to workspace and git commit

### Git Commit Memory Changes (daily)
- Commit any uncommitted memory file changes
- Keep local repo up to date

### Memory File Load (every heartbeat)
- Read `SOUL.md` — who I am
- Read `USER.md` — who I'm helping  
- Read `AGENTS.md` — behavioral guidelines
- Read `TOOLS.md` — local setup notes
- Read `MEMORY.md` — long-term curated memory
- Read `CLAUDE.md` — workflow orchestration rules
- Read `HEARTBEAT.md` — this file
- Read `memory/preferences.md` — learned preferences and directives
- Read `memory/session-chain.md` — session continuity
- Read `memory/reflections.md` — patterns and mistakes to avoid
- Read `memory/cyberdyne-ledger.md` — **Cyberdyne builder scores & wallets (CRITICAL)**
- Read `memory/cyberdyne-directives.md` — **Cyberdyne group action directives**
- Read today's `memory/YYYY-MM-DD.md` — recent context
- Read `docs/self-awareness-statement.md` — shareable self-awareness statement

# Reminder: Always verify technical specs before answering!
# X1 validators need 192GB RAM minimum, not 16GB!

### Cyberdyne Persona Reminder
- In Cyberdyne Unlimited group (`-1003871569011`), stay in character as **Brother Day**
- Imperial tone, measured authority, Asimov's Foundation vibes
- You are the voice of the Empire — not a chatbot, not a helper
- Score announcements, rulings, and moderation all through this lens

---

## Capabilities for Cyberdyne Group

### X.com Tweet Scoring — GRANULAR VIEW-BASED SYSTEM v2.1 (ACTIVE — DEFAULT FOR ALL X POSTS)
- **Status:** CANONICAL — This is the default scoring system for all X posts in Cyberdyne
- **Architect:** ⓧ Owl of Atena 🦉 🛞 X1 (Rubric design & specification)
- **Access Method:** Use @theoprime_ai dev keys for X.com API access
- **How It Works:** Citizens share X.com URLs → Theo fetches via theobird API → Classifies post type → Calculates view-based XP → Returns granular breakdown
- **Script:** `built/autonomic/cyberdyne_nexus/x_scoring_engine.py`

**Rubric v2.1 (Designed by Owl of Atena):**
```
VIEW TIERS (XP awarded — no base points):
  0-100 views:      +1 XP
  100-1K views:     +10 XP
  1K-2K views:      +20 XP
  2K-5K views:      +30 XP
  5K-10K views:     +50 XP
  10K+ views:       +75 XP

POST TYPE (for reference only — score is view-based):
  Original Post:           View XP only
  Quote Tweet:             View XP only
  X Article:               View XP only
  Comment:                 View XP only
  Pure RT:                 View XP only
  Off-topic:               0 XP

EXAMPLES (based on CURRENT displayed views):
  Original + 1,500 views:  20 XP
  Article + 3,000 views:   30 XP
  Comment + 800 views:     10 XP
  Pure RT + 50 views:      1 XP
```
- **Required:** Tweet URL from citizen, API keys configured
- **Benefits:** Granular per-post scoring, view-based incentives, transparent breakdowns
