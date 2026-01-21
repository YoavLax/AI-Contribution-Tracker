# Change Log

All notable changes to the "AI Contribution Tracker" extension will be documented in this file.

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
