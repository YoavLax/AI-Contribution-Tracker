# Agentic AI Detection - Confidence-Based Scoring System

## Overview

The AI-Commit-Tracker extension uses a **confidence-based heuristic scoring system** to detect when AI tools (like Copilot Chat Agent Mode) insert code autonomously. Changes are only marked as "Impacted by AI (Agentic)" when the confidence score exceeds a configurable threshold (default: 70%).

---

## Why Confidence-Based Detection?

### The Challenge
True deterministic detection of AI button clicks is **not possible** in VS Code:
- VS Code registers Chat commands internally before extensions activate
- Button clicks in the Chat UI directly invoke internal commands
- Keybinding-based interception only works for keyboard shortcuts, not UI buttons

### Our Solution
Instead of attempting to intercept commands, we analyze the **characteristics of code changes** using multiple heuristic signals. Each signal contributes points to a confidence score. Only when the combined score exceeds the threshold do we mark the commit.

---

## Scoring Signals

### Negative Signals
| # | Signal | Points | Trigger Condition |
|---|--------|--------|-------------------|
| 0 | **Recent paste operation** | **-50** | Paste detected within 500ms of change |

### Positive Signals
| # | Signal | Points | Trigger Condition |
|---|--------|--------|-------------------|
| 1 | VS Code window not focused | +35 | Window unfocused AND 10+ chars changed |
| 2 | Background document change | +30 | Non-active document AND 10+ chars changed |
| 3 | Multi-file rapid changes | +25 | 2+ unique files changed in last 5 seconds |
| 4a | No recent typing (large) | +40 | 100+ chars AND 3+ second typing gap |
| 4b | No recent typing (small) | +20 | 20+ chars AND 2+ second typing gap |
| 5 | Very fast insertion rate | +20 | >100 chars in changes from last 1 second |
| 6 | Chat panel visible | +20 | Chat/Copilot scheme detected in editors |
| 7 | Pure insertion (no deletions) | +15 | 20+ chars inserted AND 0 chars deleted |
| 8a | Large code block | +15 | 200+ total chars (insertions + deletions) |
| 8b | Medium code block | +8 | 100-199 total chars |
| 9 | Markdown with formatting | +10 | .md file with headers/lists/code blocks |
| 10 | Code structure patterns | +10 | Contains keywords (function, class, etc.) + 3+ statement chars |
| 11 | Complete statements | +5 | 3+ lines AND 50%+ end with ; { } ) ] : |
| 12a | Sustained background (high) | +30 | 6+ background changes in last 5 seconds |
| 12b | Sustained background (med) | +20 | 3-5 background changes in last 5 seconds |
| 13a | Large background deletion | +25 | 50+ chars deleted in non-active document |
| 13b | Large deletion (no typing) | +15 | 50+ chars deleted AND 2+ second typing gap |
| 14 | Background replacement | +15 | 10+ chars inserted AND 10+ chars deleted in background |

### Signal Notes
- **Paste detection (-50)** is deterministic via command interception, not heuristic
- **Signals 12-14** specifically target deletions, replacements, and sustained activity patterns
- **totalChars** = insertions + deletions (tracks total activity, not just additions)
- Signals can stack - a single change can trigger multiple signals
- Maximum score is capped at 100%

---

## Configuration

| Setting | Default | Range | Description |
|---------|---------|-------|-------------|
| `copilotInsightTracker.trackAgenticEdits` | `true` | boolean | Enable/disable agentic detection |
| `copilotInsightTracker.agenticConfidenceThreshold` | `70` | 50-100 | Minimum confidence % to mark as agentic |

### Threshold Guidelines
- **50%**: More detections, higher false positive risk
- **70%** (default): Balanced detection, recommended
- **85%+**: Conservative, only marks high-confidence changes

---

## Commit Message Format

When confidence exceeds threshold:
```
Impacted by AI (Agentic - 85% confidence)
```

When both inline and agentic are detected:
```
Impacted by AI (Inline + Agentic)
```

---

## Detection Scenarios

| Scenario | Expected Score | Detection | Key Signals |
|----------|---------------|-----------|-------------|
| Agent Mode: Window unfocused, multi-file | 75-100% | ✅ Detected | +35 unfocused, +30 background, +25 multi-file, +20 sustained |
| Agent Mode: Background file edits (sustained) | 70-95% | ✅ Detected | +30 background, +20/+30 sustained, +15 block size |
| Agent Mode: Single background edit | 45-70% | ⚠️ Borderline | +30 background, +20 no typing, +15 pure insertion |
| AI bulk deletion in background | 70-85% | ✅ Detected | +30 background, +25 large deletion, +20 sustained |
| AI replacement in background | 60-80% | ✅ Detected | +30 background, +15 replacement, +20 no typing |
| Chat Apply: User clicks button | 35-75% | ⚠️ Depends on context | +20 no typing, +15 block, +10 structure |
| Manual typing in active editor | 0-15% | ✅ Not flagged | No background signals |
| Copy-paste from web | -35 to +10 | ✅ Not flagged | -50 paste penalty |
| Large manual refactoring | 25-50% | ✅ Not flagged | Usually below threshold |

---

## Known Limitations

### 1. Threshold Edge Cases
Changes exactly at the threshold boundary may be inconsistently detected. Adjust threshold based on your workflow.

### 2. Cannot Distinguish AI Sources
We cannot determine which specific AI tool made the change (Copilot vs Claude vs other). All are marked as "Agentic".

### 3. Fast Human Typing
Extremely fast typists making large changes may occasionally score above threshold.

### 4. Manual Multi-File Refactoring
Using VS Code's rename symbol or find-replace across files may score as agentic.

---

## Implementation Details

### Tracking State
- `_recentChanges`: Ring buffer of recent changes (last 5 seconds), tracks `{ uri, time, chars, isBackground }`
- `_lastTypingTime`: Timestamp of last small (<5 char) change (human typing indicator)
- `_lastPasteTime`: Timestamp of last paste operation (for -50 penalty)
- `_highestConfidenceScore`: Peak score in current session (preserved until commit)

### Change Calculation
- `totalInserted`: Sum of all `text.length` in content changes
- `totalDeletions`: Sum of all `rangeLength` in content changes  
- `totalChars`: `totalInserted + totalDeletions` (total activity)
- Changes < 5 chars are treated as typing and update `_lastTypingTime`

### File Creation/Rename
- File creation during detection: Base score 45% + situational signals
- File rename during detection: Base score 35% + situational signals

### Score Preservation
- Each change calculates a new confidence score
- If new score > `_highestConfidenceScore`, it replaces the stored value
- The highest score is used when writing the commit marker
- Score resets after commit or 30 seconds of inactivity

### Git Hook Installation
- Checks `git config core.hooksPath` for custom hooks directory
- Falls back to `.git/hooks` if not set
- Appends to existing hooks (preserves Change-Id generation, etc.)
- Moves any trailing `exit 0` to the end after our code

### Cleanup
- Changes older than 10 seconds are automatically cleaned up
- Session resets after 30 seconds of inactivity

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Default threshold | 70% | Balances detection vs false positives |
| Minimum threshold | 50% | Prevents overly aggressive detection |
| Window unfocused weight | +35 | Strongest single signal - AI tools often work unfocused |
| Background change weight | +30 | Strong signal but not conclusive alone |
| Multi-file weight | +25 | Very reliable for Agent Mode |
| Sustained activity weight | +20/+30 | Aggregates many small changes that individually miss threshold |
| Paste penalty | -50 | Deterministic signal to prevent false positives from user paste |
| Track deletions | Yes | AI often deletes/replaces code, not just inserts |
| totalChars includes deletions | Yes | Ensures large replacements trigger size-based signals |
| Preserve highest score | Yes | Prevents score regression when AI makes multiple edits |

---

## Testing the Detection

1. Enable tracking and set threshold to 50% for testing
2. Open the Output panel → "AI Commit Tracker" channel
3. Use Agent Mode or Chat to make changes
4. Watch the scorer output show point breakdown
5. Adjust threshold based on your workflow

### Example Log Output
```
[Tracker] Document changed: src/example.ts (+342/-0 chars, scheme: file)
[Scorer] src/example.ts: 85%
[Scorer]   +35: VS Code unfocused
[Scorer]   +30: Background doc change
[Scorer]   +20: Multiple background changes (4 changes)
[Scorer]   +15: Pure insertion
[Scorer]   +15: Large block (342 chars)
[Tracker] ✓ AGENTIC DETECTED (85%): 342 chars in src/example.ts
```

### Testing Deletion Detection
```
[Tracker] Document changed: src/old.ts (+0/-156 chars, scheme: file)
[Scorer] src/old.ts: 75%
[Scorer]   +30: Background doc change
[Scorer]   +25: Large background deletion (156 chars deleted)
[Scorer]   +20: No recent typing (5s gap)
[Tracker] ✓ AGENTIC DETECTED (75%): 156 chars in src/old.ts
```

### Testing Paste Penalty
```
[Tracker] Document changed: src/file.ts (+200/-0 chars, scheme: file)
[Scorer] src/file.ts: 15%
[Scorer]   -50: Recent paste (120ms ago)
[Scorer]   +40: No typing + large insertion (4s gap, 200 chars)
[Scorer]   +15: Large block (200 chars)
[Scorer]   +10: Code structure
[Tracker] Below threshold (15% < 70%): src/file.ts
```

---

## Changelog

### v0.0.2 (Latest)
- Added Signal 12: Sustained background activity (+20/+30)
- Added Signal 13: Large deletion detection (+15/+25)
- Added Signal 14: Background replacement detection (+15)
- Changed `totalChars` to include both insertions AND deletions
- Added paste command interception with -50 penalty
- Fixed hook installation for custom `core.hooksPath`
- Fixed highest score preservation (was using last score)
- Added commit monitoring with detailed logging

### v0.0.1
- Initial confidence-based scoring system with 11 signals
- Inline suggestion tracking (Tab, Ctrl+Right, Ctrl+Shift+Right)
- Git hook installation and commit message tagging
Currently focused on GitHub Copilot only. Support for other tools (Cursor, Cline, Continue) may be added in future versions.

### 3. AI-Generated But Manually Pasted Code
When users click "Copy" in Chat and manually paste, we intentionally don't track this — the user made a conscious decision to manually paste, maintaining full control.

---

## VS Code Version Requirements

- **Minimum Version:** 1.85+
- **Required for:** Agent mode detection (`chatEditing.*` commands)
- **Graceful Degradation:** Older versions will still track inline suggestions and basic chat apply actions
