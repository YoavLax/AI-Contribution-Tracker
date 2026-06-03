# Open Gaps

## Gap 1 — isClaudePath heuristic was too narrow (RESOLVED)

**Discovered during:** Phase 3 test run  
**Test:** `handleStop: reads Claude transcript tokens and models at Stop time`  
**Root cause:** The `handleStop` Claude block used `claudePath.includes('.claude')` to decide whether to invoke `extractFromClaudeTranscript`. In tests, the transcript path is a system `%TEMP%` directory that doesn't contain `.claude` in its path — so the reader was never called.  
**Resolution:** Removed the path-detection heuristic entirely. Both readers (`extractFromCliTranscript` and `extractFromClaudeTranscript`) now always run against `input.transcript_path`. This is safe because the two schemas are disjoint:
- Copilot CLI uses `type:"session.model_change"`, `"assistant.message"`, `"session.shutdown"`
- Claude Code uses `type:"assistant"` (not `"assistant.message"`)

Each reader returns empty for the other's format → no double-counting possible.  
**Commit:** Included in feat commit on `users/dexterman/feature/claudeCodeSupport`.
