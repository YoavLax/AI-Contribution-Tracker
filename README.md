<div align="center">

<img src="./icon.png" alt="AI Contribution Tracker" width="128" height="128" />

# AI Contribution Tracker

**Track and measure your AI coding assistant usage with precision**

[![Version](https://img.shields.io/visual-studio-marketplace/v/YoavLax.ai-contribution-tracker?style=flat-square&label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=YoavLax.ai-contribution-tracker)
[![License](https://img.shields.io/github/license/YoavLax/AI-Contribution-Tracker?style=flat-square)](LICENSE)
[![GitHub Stars](https://img.shields.io/github/stars/YoavLax/AI-Contribution-Tracker?style=flat-square)](https://github.com/YoavLax/AI-Contribution-Tracker/stargazers)
[![Issues](https://img.shields.io/github/issues/YoavLax/AI-Contribution-Tracker?style=flat-square)](https://github.com/YoavLax/AI-Contribution-Tracker/issues)

[📦 Install](https://marketplace.visualstudio.com/items?itemName=YoavLax.ai-contribution-tracker) · [📖 Documentation](#how-it-works) · [🐛 Report Bug](https://github.com/YoavLax/AI-Contribution-Tracker/issues/new) · [💡 Request Feature](https://github.com/YoavLax/AI-Contribution-Tracker/issues/new)


</div>

---

A developer productivity tool that provides insights into how you interact with AI coding assistants.

## How it Works

The extension automatically detects when you accept AI-generated code. It supports both **Inline Suggestions** (ghost text) with deterministic detection, and **Agentic AI** interactions (Copilot Chat, Inline Chat, Agent Mode) with confidence-based detection.

When an AI suggestion is confirmed:
1.  **Detection**: For inline suggestions, the extension intercepts the Tab key. For agentic AI, it uses a multi-signal confidence scoring system.
2.  **Tracking**: It sets a temporary flag in your local git repository.
3.  **Git Integration**: A custom `commit-msg` hook is automatically installed in your repository. When you commit your changes, this hook checks for the flag and appends an "Impacted by AI" footer to your commit message.

## Features

- **Inline Suggestion Tracking**: Deterministic, zero false positives. Tracks Tab, Ctrl+Right (word), and Ctrl+Shift+Right (line) acceptances.
- **Agentic AI Detection**: Confidence-based scoring system detects Agent Mode, Chat Apply, and autonomous code insertions.
- **Configurable Threshold**: Adjust the confidence threshold (50-100%) to balance detection vs false positives.
- **Marker Consolidation**: When both inline and agentic AI are used before a commit, the message shows "Impacted by AI (Inline + Agentic)".
- **Git Integration**: Automatically tags commits that contain AI-generated code with an "Impacted by AI" trailer.
- **Privacy Focused**: No code is sent to external servers. All processing happens locally within VS Code and your Git hooks.

## Extension Settings

This extension contributes the following settings:

* `copilotInsightTracker.captureMode`: Enable or disable all tracking functionality (default: `true`).
* `copilotInsightTracker.trackAgenticEdits`: Enable or disable tracking of agentic AI edits (default: `true`).
* `copilotInsightTracker.agenticConfidenceThreshold`: Minimum confidence percentage (50-100) to mark as agentic (default: `70`).

## Agentic Detection Signals

The confidence scoring system uses 14 signals to detect AI-generated code:

### Negative Signals (Reduce Score)
| Signal | Points | Description |
|--------|--------|-------------|
| Recent paste operation | **-50** | Paste detected via Ctrl+V within 500ms |

### Positive Signals (Increase Score)
| Signal | Points | Description |
|--------|--------|-------------|
| VS Code window not focused | +35 | Changes made while window is unfocused |
| Sustained background activity | +20/+30 | 3+ (or 6+) background changes in 5 seconds |
| Background document change | +30 | Edits to non-active document |
| Multi-file rapid changes | +25 | 2+ files changed within 5 seconds |
| Large background deletion | +25 | 50+ chars deleted in non-active document |
| No recent typing (large) | +40 | 100+ chars with 3+ second typing gap |
| No recent typing (small) | +20 | 20+ chars with 2+ second typing gap |
| Fast insertion rate | +20 | >100 chars inserted per second |
| Chat panel visible | +20 | Chat-related views detected |
| Background replacement | +15 | 10+ chars inserted AND deleted in background |
| Large deletion (no typing) | +15 | 50+ chars deleted without recent typing |
| Pure insertion | +15 | Insert-only change, no text removed |
| Large code block | +15/+8 | 200+ (or 100+) characters changed |
| Markdown formatting | +10 | Headers, lists, or code blocks in .md files |
| Code structure patterns | +10 | Contains function/class definitions |
| Complete statements | +5 | Lines end with ; { } ) ] : |

Changes are only marked when confidence exceeds the threshold (default: 70%).

### Key Detection Improvements
- **Deletions tracked**: Large deletions (50+ chars) now contribute to scoring
- **Replacements caught**: Background edit+delete operations detected
- **Sustained activity**: Multiple consecutive background changes aggregate score

## Supported AI Interactions

### Inline Suggestions (Deterministic)
- **Full acceptance** (Tab): Accepts the entire ghost text suggestion
- **Word acceptance** (Ctrl+Right): Accepts the next word of the suggestion
- **Line acceptance** (Ctrl+Shift+Right): Accepts the next line of the suggestion

### Agentic AI (Confidence-Based)
- **Agent Mode**: Autonomous multi-file code changes
- **Chat Apply in Editor**: Applying code blocks from Chat
- **Background edits**: Changes to documents without active user focus

### What is NOT Tracked (Intentionally)
- **Copy from Chat + Manual Paste**: You're in full control of the paste action.
- **Terminal Commands**: Code generated by AI-suggested terminal commands.
- **Manual Typing/Editing**: Regular code editing is never tracked.

## Commit Message Examples

After accepting inline AI suggestions:
```
feat: add user authentication

Impacted by AI
```

After Agent Mode changes (with confidence score):
```
fix: resolve memory leak

Impacted by AI (Agentic - 85% confidence)
```

After using both inline and agentic in the same session:
```
refactor: improve performance

Impacted by AI (Inline + Agentic)
```

## Threshold Guidelines

- **50%**: More detections, higher false positive risk
- **70%** (default): Balanced detection, recommended for most users
- **85%+**: Conservative, only marks high-confidence changes

## Known Limitations

1. **Threshold Edge Cases**: Changes exactly at the threshold boundary may be inconsistently detected.
2. **Cannot Distinguish AI Sources**: Cannot determine which AI tool made the change (Copilot vs Claude vs other).
3. **Fast Human Typing**: Extremely fast typists making large changes may occasionally score above threshold.
4. **Multi-File Refactoring**: VS Code's rename symbol or find-replace across files may score as agentic.
5. **Paste Penalty**: The -50 paste penalty is deterministic and may occasionally penalize legitimate AI operations if you paste immediately before them.

## How It Works (Technical)

### Change Tracking
- **totalChars**: Tracks both insertions AND deletions (total activity)
- **Background detection**: Changes to non-active documents score higher
- **Sustained activity**: Consecutive background changes within 5 seconds aggregate

### Score Preservation
- The **highest confidence score** in a session is preserved for commit tagging
- Sessions reset after 30 seconds of inactivity or after a commit

### Custom Git Hooks Path
- Automatically detects `git config core.hooksPath` setting
- Installs hook in the correct location (global or local)

## Requirements

- VS Code 1.85 or later
- Git installed and repository initialized

## Core Team
AI Contribution Tracker is a collaboration project by:

|                                                                                   Author                                                                                    |                                                                                   Author                                                                                    |                                                                                 Contributor                                                                                  |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <img src="https://github.com/YoavLax.png?size=115" width="115"><br><sub>@YoavLax</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/YoavLax)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/yoav-lax-2127b9189/) | <img src="https://github.com/davidexterman.png?size=115" width="115"><br><sub>@davidexterman</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/davidexterman)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/david-exterman-a755a7123/) | <img src="https://camo.githubusercontent.com/227ad1394a807d1283ff3240b89d669f4a3eef68443e72b7dfb1c794a6af0161/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f676974687562253230636f70696c6f742d3030303030303f7374796c653d666f722d7468652d6261646765266c6f676f3d676974687562636f70696c6f74266c6f676f436f6c6f723d7768697465" width="115"><br><sub>@GitHub‑Copilot</sub><br><br>[![GitHub](https://img.shields.io/badge/GitHub-000000?style=for-the-badge&logo=github&logoColor=white)](https://github.com/features/copilot)<br>[![LinkedIn](https://img.shields.io/badge/LinkedIn-0077B5?style=for-the-badge&logo=linkedin&logoColor=white)](https://www.linkedin.com/products/github-copilot/) |

