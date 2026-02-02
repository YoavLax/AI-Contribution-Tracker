# AI Contribution Tracker - Copilot Instructions

## Project Overview

This is a **VS Code extension** that tracks AI-generated code contributions by detecting inline suggestions and agentic AI edits, then tagging commits with "Impacted by AI" markers using global git hooks.

> **📊 Platform Components**: The analytics dashboard and GitHub sync service have been moved to [AI-Contribution-Tracker-Platform](https://github.com/Varonis-Systems/AI-Contribution-Tracker-Platform)

## Key Detection Pattern

AI-impacted commits are identified by the presence of `"Impacted by AI"` (case-insensitive) in the commit message.

## Development Workflow

### Extension Development
```bash
npm run compile        # One-time build
npm run watch          # Watch mode (or press F5 in VS Code)
npm run test           # Run extension tests
```
Press **F5** to launch Extension Development Host for debugging.

### Key Components

- [src/extension.ts](src/extension.ts) - Extension activation and global git hooks setup
- [src/tracker.ts](src/tracker.ts) - AI detection logic with confidence scoring
- [esbuild.js](esbuild.js) - Build configuration for extension bundling

### Global Git Hooks

The extension uses global git hooks configured via `core.hooksPath`:
- **Installation**: `setupGlobalGitHooks()` in [extension.ts](src/extension.ts) runs on first activation
- **Hook Location**: `context.globalStorageUri.fsPath + '/hooks'`
- **Configuration**: `git config --global core.hooksPath <hooks-directory>`
- **commit-msg hook**: Appends AI markers to commits when tracking flags are present

## Detection Patterns

### Inline Suggestions (Deterministic)
- **Command interception pattern**: Wrapper commands in [tracker.ts](src/tracker.ts) intercept Tab, Ctrl+Right, Ctrl+Shift+Right
- **Zero false positives**: Only tracks actual keyboard-based acceptances

### Agentic AI (Confidence-Based)
- **Multi-signal scoring**: 14+ signals evaluate changes (background edits, typing patterns, insertion speed, etc.)
- **Threshold configurable**: Default 70%, adjustable 50-100%
- **Preserves highest score**: Session maintains peak confidence for commit tagging

## Testing Conventions

- Extension tests: VS Code test runner in `src/test/`
- Test against git repositories to verify hook installation and commit tagging

## Important Files

- [tracker.ts](src/tracker.ts) - Core detection logic with confidence scoring signals
- [extension.ts](src/extension.ts) - Extension entry point and global hooks setup
- [package.json](package.json) - Extension manifest and VS Code integration points
