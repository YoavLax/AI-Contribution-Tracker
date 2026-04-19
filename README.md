<div align="center">

# AI Contribution Tracker

**Automatically tag every git commit with detailed AI usage metadata**

[![Version](https://img.shields.io/visual-studio-marketplace/v/YoavLax.ai-contribution-tracker?style=flat-square&label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=YoavLax.ai-contribution-tracker)
[![License](https://img.shields.io/github/license/YoavLax/AI-Contribution-Tracker?style=flat-square)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/YoavLax/AI-Contribution-Tracker?style=flat-square)](https://github.com/YoavLax/AI-Contribution-Tracker/stargazers)
[![Issues](https://img.shields.io/github/issues/YoavLax/AI-Contribution-Tracker?style=flat-square)](https://github.com/YoavLax/AI-Contribution-Tracker/issues)

[📦 Install](https://marketplace.visualstudio.com/items?itemName=YoavLax.ai-contribution-tracker) · [📖 Documentation](#how-it-works) · [🐛 Report Bug](https://github.com/YoavLax/AI-Contribution-Tracker/issues/new) · [💡 Request Feature](https://github.com/YoavLax/AI-Contribution-Tracker/issues/new)



---

Know exactly how AI shaped every commit — which models, how many prompts, which sub-agents — all captured automatically in your git history.

</div>

## Core Team

AI Contribution Tracker is a collaboration project by:

|                                                                                   Author                                                                                    |                                                                                   Author                                                                                    |                                                                                 Contributor                                                                                  |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <img src="https://github.com/YoavLax.png?size=115" width="115"><br><sub>@YoavLax</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/YoavLax)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/yoav-lax-2127b9189/) | <img src="https://github.com/davidexterman.png?size=115" width="115"><br><sub>@davidexterman</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/davidexterman)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/david-exterman-a755a7123/) | <img src="https://camo.githubusercontent.com/227ad1394a807d1283ff3240b89d669f4a3eef68443e72b7dfb1c794a6af0161/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f676974687562253230636f70696c6f742d3030303030303f7374796c653d666f722d7468652d6261646765266c6f676f3d676974687562636f70696c6f74266c6f676f436f6c6f723d7768697465" width="115"><br><sub>@GitHub‑Copilot</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/features/copilot)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/products/github-copilot/) |

</div>

---

## How It Works

The extension uses two complementary detection mechanisms to track AI contributions and automatically append a rich `Impacted by AI` marker to your commit messages.

### 1. Copilot Hooks (Agent Mode & Sub-agents)

[VS Code Copilot Hooks](https://code.visualstudio.com/docs/copilot/customization/hooks) fire lifecycle events during every Copilot chat session. The extension installs a lightweight Node.js handler that listens to five events:

| Hook Event | What It Tracks |
|---|---|
| `SessionStart` | Records the session ID and agent mode (e.g., `new`, `edit`) |
| `UserPromptSubmit` | Counts user prompts (excludes sub-agent delegated prompts) |
| `SubagentStart` | Records sub-agent type (e.g., `Explore`) and increments count |
| `SubagentStop` | Decrements the active sub-agent counter |
| `Stop` | Extracts models from VS Code logs, writes the flag file |

On `Stop`, the handler parses the VS Code Copilot Chat log file to extract the exact models used — separated into **user-selected models** (from `[panel/editAgent]` entries) and **sub-agent models** (from `[tool/runSubagent*]` entries). Log parsing is scoped by session ID and timestamp to ensure only data from the current session is included.

All state accumulates in `.git/ai-tracker-state.json` until consumed by the commit-msg hook.

### 2. Inline Suggestion Tracking (Deterministic)

For ghost-text completions, the extension intercepts acceptance commands with zero false positives:

| Keybinding | Action |
|---|---|
| `Tab` | Accept full inline suggestion |
| `Ctrl+Right` | Accept next word |
| `Ctrl+Shift+Right` | Accept next line |

When an inline suggestion is accepted, a flag is written to `.git/AI_IMPACT_PENDING`.

### 3. Git Integration

A global `commit-msg` hook (auto-installed via `core.hooksPath`) checks for the `AI_IMPACT_PENDING` flag at commit time. If present, it appends the marker to the commit message and cleans up both the flag and the accumulated state file.

---

## Commit Message Examples

**Agent mode with a single model and one prompt:**
```
feat: add user authentication

Impacted by AI (Agent mode: new | Model: claude-sonnet-4.6 | Prompts: 1)
```

**Multiple models, sub-agents, and several prompts:**
```
refactor: improve performance

Impacted by AI (Agent mode: new | Model: claude-sonnet-4.6, gpt-4o | Prompts: 3 | Sub-agents mode: Explore | sub-Agent models: claude-haiku-4.5 | sub-Agent prompts: 4)
```

**Inline suggestions only:**
```
fix: resolve null check

Impacted by AI (Inline)
```

**Both inline and agent mode in the same session:**
```
docs: update readme

Impacted by AI (Inline + Agent mode: new | Model: gemini-3.1-pro-preview | Prompts: 2)
```

---

## Marker Fields

The `Impacted by AI (...)` marker can contain any combination of the following fields:

| Field | Description | Example |
|---|---|---|
| `Agent mode` | The top-level agent type that initiated the session | `new`, `edit` |
| `Model` | User-selected model(s) used for the main agent | `claude-sonnet-4.6`, `gpt-4o` |
| `Prompts` | Number of user prompts (excludes sub-agent internal prompts) | `3` |
| `Sub-agents mode` | Types of sub-agents invoked | `Explore` |
| `sub-Agent models` | Model(s) used internally by sub-agents | `claude-haiku-4.5` |
| `sub-Agent prompts` | Total number of sub-agent invocations | `4` |
| `Inline` | Present when inline ghost-text suggestions were accepted | — |

---

## Features

- **Automatic** — Install once, every AI-assisted commit is tagged. No manual steps.
- **Rich Metadata** — Captures model names, prompt counts, agent types, and sub-agent details.
- **Separated Models** — User-selected models and internal sub-agent models are tracked independently.
- **Session-Scoped** — Log parsing is scoped to the correct VS Code window and time range, preventing cross-window or cross-commit leakage.
- **Inline + Agent** — Tracks both inline ghost-text acceptances and full agent/chat sessions. Merges them when both occur before a commit.
- **Global Git Hooks** — One hook covers all repositories. No per-repo setup needed.
- **Privacy Focused** — All processing happens locally. No code or prompts are sent to external servers.

## Requirements

- VS Code 1.100.0 or later (with Copilot Hooks support)
- Git installed and repository initialized
- GitHub Copilot extension installed

## Development

```bash
npm run compile        # Build the extension
npm run watch          # Watch mode for development
npm run test           # Run tests
```

Press **F5** to launch the Extension Development Host for debugging.

### Key Files

| File | Purpose |
|---|---|
| `src/extension.ts` | Extension activation, global git hooks setup, Copilot hooks config |
| `src/hook-handler.ts` | Standalone Node.js hook handler (Copilot Hook events) |
| `src/tracker.ts` | Inline suggestion detection with deterministic interception |

## License

[MIT](LICENSE)

