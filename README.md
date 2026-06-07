<div align="center">

# AI Contribution Tracker

**Automatically tag every git commit with AI usage metadata — models, tokens, prompts, and cost signals. Works with VS Code Copilot,  [GitHub Copilot CLI](https://github.com/features/copilot/cli), Claude Code & OpenCode. All local. Zero config.**

[![Version](https://img.shields.io/visual-studio-marketplace/v/YoavLax.ai-contribution-tracker?style=flat-square&label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=YoavLax.ai-contribution-tracker)
[![License](https://img.shields.io/github/license/YoavLax/AI-Contribution-Tracker?style=flat-square)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/YoavLax/AI-Contribution-Tracker?style=flat-square)](https://github.com/YoavLax/AI-Commit-Tracker/stargazers)
[![Issues](https://img.shields.io/github/issues/YoavLax/AI-Contribution-Tracker?style=flat-square)](https://github.com/YoavLax/AI-Contribution-Tracker/issues)

[📦 Install](https://marketplace.visualstudio.com/items?itemName=YoavLax.ai-contribution-tracker) · [📖 How It Works](#how-it-works) · [🐛 Report Bug](https://github.com/YoavLax/AI-Contribution-Tracker/issues/new) · [💡 Request Feature](https://github.com/YoavLax/AI-Contribution-Tracker/issues/new)

---

*Know exactly how AI shaped every commit — which models were used, how many tokens were consumed per model (including reasoning tokens and cache hits), how many prompts were exchanged, and which sub-agents were involved. All captured automatically in your git history.*

</div>

---

## What Gets Recorded

Every AI-assisted commit automatically receives a detailed marker. Here are real examples:

**Single model, one prompt:**
```
feat: add dark mode toggle

Impacted by AI (Agent mode: new | Model: claude-sonnet-4.6 | Prompts: 1 | Tokens: claude-sonnet-4-6: 48k in/2k out (41k cached))
```

**Multi-model session — Claude for reasoning, Gemini for search:**
```
refactor: split auth service into separate module

Impacted by AI (Agent mode: new | Model: claude-sonnet-4.6, gemini-3.1-pro-preview | Prompts: 2 | Tokens: claude-sonnet-4-6: 296k in/5k out (243k cached) | gemini-3.1-pro-preview: 104k in/678 out (74k cached))
```

**Reasoning model with thinking tokens:**
```
fix: resolve race condition in async queue

Impacted by AI (Agent mode: copilot | Model: gpt-5.4 | Prompts: 1 | Tokens: gpt-5.4-2026-03-05: 143k in/1k out (118k cached) +333 reasoning)
```

**Sub-agents + inline suggestions in the same session:**
```
docs: rewrite contributing guide

Impacted by AI (Inline + Agent mode: new | Model: claude-sonnet-4.6 | Prompts: 3 | Sub-agents mode: Explore | sub-Agent prompts: 2 | Tokens: claude-sonnet-4-6: 180k in/4k out (155k cached))
```

**GitHub Copilot CLI — committed after session closed (full token breakdown):**
```
feat: add rate limiting middleware

Impacted by AI (Agent mode: copilot | Model: claude-sonnet-4.6 | Prompts: 2 | Tokens: claude-sonnet-4-6: 62k in/1k out (48k cached))
```

**GitHub Copilot CLI — committed while session still open (tokens not yet available):**
```
feat: add rate limiting middleware

Impacted by AI (Agent mode: copilot | Model: claude-sonnet-4.6 | Prompts: 2)
```
> Token data is written to the CLI session transcript only when the session closes. Commit after ending the session to include the full per-model breakdown.

---

## How It Works

The extension uses three complementary mechanisms, all running locally.

### 1. Token Usage via OTEL

The extension activates Copilot's built-in local OpenTelemetry span exporter (`github.copilot.chat.otel.dbSpanExporter.enabled`), which writes real measured token counts to a local SQLite database (`agent-traces.db`) — no network required, no third-party telemetry.

At the end of each session, the hook handler queries that database and records **per-model** token breakdowns directly in the commit marker:

| Token Field | Description |
|---|---|
| `NNNk in` | Input tokens sent to the model |
| `NNNk out` | Output tokens generated |
| `(NNNk cached)` | Prompt cache hits (billed at reduced rate) |
| `+NNN reasoning` | Internal chain-of-thought tokens (reasoning models only) |

Token data is **time-scoped** to the current session — spans from previous sessions in the same VS Code window are excluded, so each commit reflects only the tokens consumed for that specific piece of work.

### 2. Copilot Hooks (VS Code & GitHub Copilot CLI)

[VS Code Copilot Hooks](https://code.visualstudio.com/docs/copilot/customization/hooks) fire lifecycle events during every Copilot chat session. The same hooks protocol is also used by [GitHub Copilot CLI](https://github.com/features/copilot/cli). A lightweight Node.js handler listens to five events:

| Hook Event | What It Tracks |
|---|---|
| `SessionStart` | Records the session ID and agent mode (e.g., `new`, `copilot`) |
| `UserPromptSubmit` | Counts user prompts; ignores sub-agent delegated prompts |
| `SubagentStart` | Records sub-agent type (e.g., `Explore`) and increments count |
| `SubagentStop` | Decrements the active sub-agent counter |
| `Stop` | Queries token DB / CLI transcript, parses log for model names, writes the flag file |

On `Stop`, the handler also parses the VS Code Copilot Chat log to extract model names — separated into **user-selected models** (`[panel/editAgent]` entries) and **sub-agent models** (`[tool/runSubagent*]` entries). Parsing is scoped by session ID and timestamp.

State accumulates in `.git/ai-tracker-state.json` until consumed by the commit-msg hook.

#### GitHub Copilot CLI behavior

Copilot CLI fires the same hook events, but its working directory is typically the home folder or a system path rather than the repository. The handler detects this, buffers the session state in a temporary pending location, and merges it into the correct repo automatically at commit time — no extra configuration needed.

Token data for CLI sessions is read from the session transcript at `~/.copilot/session-state/<session_id>/events.jsonl`. The full per-model breakdown is written as a `session.shutdown` entry **only when the CLI session ends**:

| Commit timing | What appears in the marker |
|---|---|
| After the CLI session closes | Full token breakdown (input / output / cached / reasoning) |
| While the session is still open | Model name and prompt/agent counts only — no token numbers |

### 3. Inline Suggestion Tracking (Deterministic)

For ghost-text completions, the extension intercepts acceptance keystrokes with zero false positives:

| Keybinding | Action |
|---|---|
| `Tab` | Accept full inline suggestion |
| `Ctrl+Right` | Accept next word |
| `Ctrl+Shift+Right` | Accept next line |

When an inline suggestion is accepted, the flag is written to `.git/AI_IMPACT_PENDING`. If an agent session also ran before the commit, both are merged: `Impacted by AI (Inline + Agent mode: ...)`.

### 4. Git Integration

A global `commit-msg` hook (auto-installed via `git config --global core.hooksPath`) fires at every commit across all your repositories. It reads `AI_IMPACT_PENDING`, appends the marker to the commit message, then removes both the flag and the state file.

### 5. OpenCode Integration

The extension integrates with OpenCode via the [`@rachel_rotenberg/ai-contribution-tracker`](https://www.npmjs.com/package/@rachel_rotenberg/ai-contribution-tracker) npm plugin, which hooks into OpenCode's session lifecycle events using the same flag-file mechanism as the Copilot hooks. **The plugin is automatically registered** in `~/.config/opencode/opencode.json` when the VS Code extension activates — no manual setup needed. OpenCode installs it via Bun on startup. Every git commit made from an OpenCode session is automatically tagged.

| Hook / Event | What It Tracks |
|---|---|
| `session.created` | Records session ID and agent mode (e.g., `opencode/build`, `opencode/senna`) |
| `chat.message` | Counts user prompts; ignores sub-agent delegated prompts |
| `message.updated` | Per-model token breakdown (input / output / cached / reasoning) — accumulated with delta tracking to prevent double-counting |
| `tool.execute.after` (task) | Sub-agent invocations (type extracted from args) |
| `session.idle` / `session.status` | Triggers final state write and flag creation |

**Installation:**

**Automatic** (recommended): The VS Code extension adds `@rachel_rotenberg/ai-contribution-tracker` to `~/.config/opencode/opencode.json` on activation. OpenCode picks it up on next startup. On Windows, the extension also detects WSL and writes the config into the default WSL distro automatically.

**Manual** (for use without the VS Code extension):

Add to your `~/.config/opencode/opencode.json`:
```json
{
  "plugin": [
    "@rachel_rotenberg/ai-contribution-tracker"
  ]
}
```

**Example output with OpenCode session:**
```
feat: add rate limiter middleware

Impacted by AI (Agent mode: opencode/build | Model: claude-sonnet-4-6 | Prompts: 4 | Tokens: claude-sonnet-4-6: 120k in/3k out (98k cached))
```

**With custom agents (e.g., your team's domain agents):**
```
refactor: split auth service

Impacted by AI (Agent mode: opencode/senna | Model: claude-opus-4-6 | Prompts: 2 | Sub-agents mode: unspecified-high | sub-Agent prompts: 3 | Tokens: claude-opus-4-6: 296k in/5k out (243k cached))
```

---

## Marker Field Reference

| Field | Description | Example |
|---|---|---|
| `Agent mode` | Top-level agent type (Copilot: `new`, `copilot`, `edit`; OpenCode: `opencode/build`, `opencode/senna`, etc.) | `new`, `copilot`, `edit`, `opencode/build` |
| `Model` | User-selected model(s) for the main agent | `claude-sonnet-4.6`, `gpt-5.4` |
| `Prompts` | Number of user prompts (excludes sub-agent internal prompts) | `3` |
| `Sub-agents mode` | Types of sub-agents invoked | `Explore`, `Plan` |
| `sub-Agent models` | Models used internally by sub-agents | `claude-haiku-4.5` |
| `sub-Agent prompts` | Total sub-agent invocations | `4` |
| `Tokens` | Per-model token breakdown (input / output / cached / reasoning) | `claude-sonnet-4-6: 48k in/2k out (41k cached)` |
| `Inline` | Present when ghost-text completions were accepted | — |

---

## Features

- **Automatic** — Install once; every AI-assisted commit is tagged from that moment on. No per-repo setup.
- **GitHub Copilot CLI** — Works with [GitHub Copilot CLI](https://github.com/features/copilot/cli) in addition to VS Code. CLI sessions are detected and merged into the correct repo at commit time automatically.
- **Token Tracking** — Real measured token counts from Copilot's OTEL pipeline (VS Code) or session transcripts (Copilot CLI), not estimates.
- **Per-Model Breakdown** — Each model's input, output, cached, and reasoning tokens recorded separately — ready for cost calculation.
- **Reasoning Tokens** — Thinking tokens from reasoning models (GPT-5.x, o1, o3) are tracked and labeled `+NNN reasoning`.
- **Session-Scoped** — Token queries are time-bounded to the current session; previous commits in the same window don't bleed in.
- **Multi-Session Accumulation** — Multiple agent sessions before a single commit are merged and their token counts summed.
- **Inline + Agent** — Tracks both ghost-text acceptances and full chat sessions; merges them when both occur before a commit.
- **Global Git Hooks** — One hook covers all repositories. No per-repo initialization.
- **OpenCode Support** — Standalone plugin tracks OpenCode sessions with per-model token breakdown and custom agent labels.
- **Privacy First** — Everything runs locally. No code, prompts, or token data leaves your machine.

---

## Requirements

- VS Code 1.100.0 or later (Copilot Hooks support)
- GitHub Copilot extension installed
- Git initialized in your repository
- Node.js 22+ (for `node:sqlite` built-in — included with VS Code's bundled Node)

---

## Core Team

<div align="center">

|                                                                                   Author                                                                                    |                                                                                   Author                                                                                    |                                                                                 Contributor                                                                                  |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <img src="https://github.com/YoavLax.png?size=115" width="115"><br><sub>@YoavLax</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/YoavLax)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/yoav-lax-2127b9189/) | <img src="https://github.com/davidexterman.png?size=115" width="115"><br><sub>@davidexterman</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/davidexterman)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/david-exterman-a755a7123/) | <img src="https://camo.githubusercontent.com/227ad1394a807d1283ff3240b89d669f4a3eef68443e72b7dfb1c794a6af0161/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f676974687562253230636f70696c6f742d3030303030303f7374796c653d666f722d7468652d6261646765266c6f676f3d676974687562636f70696c6f74266c6f676f436f6c6f723d7768697465" width="115"><br><sub>@GitHub-Copilot</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/features/copilot)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/products/github-copilot/) |

</div>

---

## Development

```bash
npm run compile        # One-time build
npm run watch          # Watch mode (or press F5 in VS Code)
npm run test           # Run extension tests
```

Press **F5** to launch the Extension Development Host for debugging.

### Key Files

| File | Purpose |
|---|---|
| `src/extension.ts` | Extension activation, global git hooks setup, Copilot hooks config, OTEL enablement |
| `src/hook-handler.ts` | Standalone Node.js hook handler — session tracking, token DB query, marker formatting |
| `src/tracker.ts` | Inline suggestion detection via deterministic command interception |
| `src/opencode-plugin.ts` | OpenCode plugin — session tracking, token accumulation via `message.updated`, writes to the same flag files as Copilot hooks |

---

## License

[MIT](LICENSE)