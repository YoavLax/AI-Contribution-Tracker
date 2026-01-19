# AI Commit Tracker

A developer productivity tool that provides insights into how you interact with AI coding assistants.

## How it Works

The extension automatically detects when you accept AI-generated code suggestions (currently supporting Inline Suggestions) by intercepting the acceptance commands.

When an AI suggestion is confirmed:
1.  **Detection**: The extension uniquely identifies the "Accept" action (Tab, Ctrl+Right, etc.) and verifies the subsequent document change.
2.  **Tracking**: It sets a temporary flag in your local git repository.
3.  **Git Integration**: A custom `commit-msg` hook is automatically installed in your repository. When you commit your changes, this hook checks for the flag and appends an "Impacted by AI" footer to your commit message.

## Features

- **Deterministic Tracking**: Zero false positives. Only tracks code you explicitly accept from AI.
- **Git Integration**: Automatically tags commits that contain AI-generated code with an "Impacted by AI" trailer.
- **Privacy Focused**: No code is sent to external servers. All processing happens locally within VS Code and your Git hooks.

## Extension Settings

This extension contributes the following settings:

* `copilotInsightTracker.captureMode`: Enable or disable the tracking functionality (default: `true`).

## Supported AI Interactions

- **Inline Suggestions**: Full acceptance (Tab), Word acceptance (Ctrl+Right), and Line acceptance.
