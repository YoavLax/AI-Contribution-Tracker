# Change Log

All notable changes to the "AI Contribution Tracker" extension will be documented in this file.
## [2.2.0] - 2026-05-19

### Added
- **GitHub Copilot CLI support**: sessions from [GitHub Copilot CLI](https://github.com/features/copilot/cli) are now tracked automatically — no extra configuration needed. The hook handler detects CLI events (which arrive without a git repo context), buffers them in a pending state, and merges them into the correct repository at commit time.
- **CLI session transcript parsing**: model names and full per-model token breakdowns are read from `~/.copilot/session-state/<session_id>/events.jsonl`. Token data is sourced from the `session.shutdown` entry written when the CLI session ends.
- **Multi-session accumulation**: multiple Copilot agent sessions (VS Code or CLI) before a single commit are merged, with prompt counts and token totals summed across all sessions.
- **State reset lifecycle**: session state is cleanly reset after each commit, preventing data from bleeding into subsequent commits.

### Changed
- `CommitMsg` handler now refreshes the flag with full token data (including tokens already computed at `Stop` time) before the commit is finalized.

### Notes
- When committing during an active Copilot CLI session (before the session closes), the marker will include the model and prompt count but **not** token counts — those are only available after the session ends and `session.shutdown` is written to the transcript.

## [2.1.3] - 2026-05-11

### Fixed
- Mac: hook wrapper now resolves `NODE_BIN` at runtime by probing Homebrew, Volta, asdf, nvm, and system paths — eliminates `exec: node: not found` warning when VS Code launches without the user's full shell PATH
- Prompt count double-counting: `UserPromptSubmit` events without user-visible text (agentic tool-result continuations) are no longer counted
- Prompt count duplicated due to stale per-repo `.github/hooks/ai-commit-tracker.json` config; extension now auto-removes legacy per-repo hook configs on activation
## [2.1.1] - 2026-05-11

### Fixed
- Mac: resolve absolute `node` path at setup time so hooks work when VS Code launches without a full shell PATH (nvm, Homebrew, etc.)
- Prompt count double-counting: `UserPromptSubmit` events with no user-visible text (agentic tool-result continuations) are no longer counted
- Prompt count duplicated due to stale per-repo `.github/hooks/ai-commit-tracker.json` config; extension now auto-removes legacy per-repo hook configs on activation

## [2.1.0] - 2026-05-07

### Added
- Token tracking via OpenTelemetry (OTEL): query token counts at commit time if the session Stop event hasn't fired yet
- `Co-authored-by` trailer automatically added to commits that include AI contributions

### Changed
- Major refactor of `CopilotTracker` to focus on inline suggestions; agentic command handling removed
- Agentic AI detection now uses confidence-based scoring without command interception overhead

### Fixed
- Eagerly write `AI_IMPACT_PENDING` flag before the Stop event fires to prevent missed tagging
- Deduplicate subagent models that also appear in the main models list

## [1.0.0] - 2026-01-21

### Added
- Initial stable release
- Deterministic inline suggestion tracking (Tab, Ctrl+Right, Ctrl+Shift+Right)
- Confidence-based agentic AI detection system with 14 signals
- Configurable confidence threshold (50-100%)
- Automatic Git commit message tagging with "Impacted by AI" footer
- Support for inline suggestions, Agent Mode, and Chat apply interactions
- Custom git hooks integration with automatic installation
- Configuration setting:
  - `agenticConfidenceThreshold`: Adjust detection sensitivity (default: 70%)
- Privacy-focused: all processing happens locally
- Marker consolidation for mixed inline + agentic sessions

### Features
- Multi-signal confidence scoring system for agentic detection
- Background activity tracking
- Multi-file change detection
- Paste operation penalty to reduce false positives
- Session-based score preservation
- Support for custom Git hooks paths
