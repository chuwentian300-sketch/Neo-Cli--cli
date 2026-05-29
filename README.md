# NEO-CLI

Multi-API cache-first coding agent with auto model switching.

## Features

- **Cache-First Architecture** — Stable prefix caching across Claude, OpenAI, DeepSeek
- **Auto Model Switching** — High-tier for planning, low-tier for execution
- **MIMO Thinking Protocol** — Adaptive depth thinking (simple/medium/complex)
- **Full-Screen TUI** — Rich terminal interface with mouse support, scroll, clipboard
- **Tool System** — File read/write/edit, shell commands, grep, glob
- **Session Persistence** — JSONL-based session history with resume support
- **MBTI Personality** — Customize AI communication style

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Initialize config
npx neo init

# Start coding
npx neo code
```

## Configuration

Config file: `~/.neo-cli/config.json`

```json
{
  "providers": {
    "deepseek": { "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com" },
    "openai": { "apiKey": "sk-...", "baseUrl": "https://api.openai.com/v1" },
    "claude": { "apiKey": "sk-...", "baseUrl": "https://api.anthropic.com/v1" }
  },
  "models": {
    "high": { "provider": "deepseek", "id": "deepseek-v4-pro" },
    "low": { "provider": "deepseek", "id": "deepseek-v4-flash" }
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help |
| `/api` | Configure API (URL/Key/Model) |
| `/mbti` | Set personality type |
| `/thinking` | Set thinking animation |
| `/copy` | Copy last AI response |
| `/model` | Show current models |
| `/mode` | Toggle auto/manual mode |
| `/clear` | Clear output |
| `/session` | Show session info |
| `/resume` | Resume history session |
| `/compact` | Force context compression |
| `/exit` | Exit |

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `ESC` | Abort task / Clear input |
| `Tab` | Toggle auto/manual mode |
| `↑↓` | History / Command palette |
| `←→` | Cursor movement |
| `PgUp/PgDn` | Scroll output |
| `Ctrl+U` | Clear input |
| `Shift+Click` | Select text |

## Architecture

```
src/
├── adapters/     # Claude, OpenAI, DeepSeek API adapters
├── cli/          # Full-screen TUI interface
├── config/       # Configuration loading (zod)
├── core/         # CacheFirstLoop, context manager
├── memory/       # Persistent memory system
├── prompts/      # System prompts, mimo protocol, animations
├── session/      # JSONL session persistence
└── tools/        # File, shell, search tools
```

## License

MIT
