# OpenClaw QMD Configuration

**Note:** QMD in OpenClaw is a **vector search and BM25 full-text search** database system used for memory management. It is NOT Quarto Markdown.

## Overview

OpenClaw uses QMD as its memory backend for semantic search across agent context. The system indexes content into a SQLite database and supports both vector embeddings and keyword search.

## Configuration

**Primary config**: `~/.openclaw/openclaw.json`

```json
"memory": {
  "backend": "qmd",
  "citations": "auto",
  "qmd": {
    "command": "/home/jack/.local/bin/qmd-search-wrapper",
    "searchMode": "query",
    "includeDefaultMemory": true,
    "update": {
      "interval": "5m",
      "debounceMs": 15000,
      "onBoot": true,
      "waitForBootSync": false,
      "embedInterval": "1h",
      "commandTimeoutMs": 30000,
      "updateTimeoutMs": 120000,
      "embedTimeoutMs": 300000
    },
    "limits": {
      "maxResults": 6,
      "maxSnippetChars": 2000,
      "maxInjectedChars": 8000,
      "timeoutMs": 15000
    },
    "scope": {
      "default": "allow"
    }
  }
}
```

## Key Settings

| Setting | Value | Description |
|---------|-------|-------------|
| **command** | `~/.local/bin/qmd-search-wrapper` | Custom wrapper script around `qmd.original` |
| **searchMode** | `query` | Wrapper translates this to "search" for performance |
| **update.interval** | `5m` | Index update frequency |
| **update.debounceMs** | `15000` | 15s debounce for rapid updates |
| **update.onBoot** | `true` | Re-index on startup |
| **update.embedInterval** | `1h` | Vector embedding refresh interval |
| **limits.maxResults** | `6` | Max search results returned |
| **limits.maxSnippetChars** | `2000` | Max characters per result snippet |
| **limits.maxInjectedChars** | `8000` | Max total characters injected into context |
| **limits.timeoutMs** | `15000` | 15s query timeout |

## Infrastructure

| Component | Path |
|-----------|------|
| QMD wrapper | `~/.local/bin/qmd-search-wrapper` |
| QMD binary | `~/.bun/bin/qmd.original` |
| SQLite index | `~/.cache/qmd/index.sqlite` (~1.1 GB) |
| Health monitor | `~/.openclaw/workspace/scripts/qmd-health.py` |

## Agent-Specific QMD Directories

- `~/.openclaw/agents/main/qmd/`
- `~/.openclaw/agents/cyberdyne/qmd/`
- `~/.openclaw/agents/xchat/qmd/`

## How It Works

1. The **wrapper script** (`qmd-search-wrapper`) sits between OpenClaw and the actual `qmd.original` binary, translating `query` mode to `search` mode and logging embed operations.
2. On boot, QMD re-indexes content (120s timeout).
3. Every 5 minutes, the index is updated (with 15s debounce).
4. Every hour, vector embeddings are refreshed (300s timeout).
5. When a search is triggered, QMD returns up to 6 results (max 8000 chars total) within a 15s timeout.

## Documentation System

OpenClaw's actual documentation uses **Mintlify** (not Quarto):
- Config: `docs/docs.json`
- Theme: "mint"
- Dev server: `mint dev`
- Supports English, Chinese, and Japanese
