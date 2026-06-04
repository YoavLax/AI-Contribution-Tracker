# Open Gaps

## Gap 2 — Live test contamination by active Copilot Chat session (WORKAROUND APPLIED)

**Discovered during:** Gate 2 live test execution — G2-4 (no-duplication plain commit)
**Test:** `G2-4: plain commit after AI commit should have NO marker`
**Actual result:** `Impacted by AI (Agent mode: copilot | Prompts: 1)` appeared on the plain commit.
**Root cause:** When live tests are run from VS Code Copilot Chat (as this agent does), the
Copilot Chat extension fires `SessionStart`/`UserPromptSubmit`/`Stop` hooks into the scratch
repo's git dir because the terminal CWD was `C:\tmp\ai-test-scratch`. Each tool call / message
processed by the agent session counts as a Copilot prompt. By the time the plain commit ran,
a fresh Copilot session had already been written to the scratch repo state.

**Positive finding:** The G2-4 marker showed `Agent mode: copilot | Prompts: 1` only — no
Claude — which **confirms `resetStateAfterCommit` correctly cleared the Claude state** from G2-3.
The contamination only adds a new Copilot session; it does not resurrect the cleared Claude state.

**Workaround for G2-4 and G2-5:** Clear `AI_IMPACT_PENDING` and `ai-tracker-state.json`
immediately before the plain commit. This removes the Copilot Chat contamination and isolates
the plain commit from the test-runner session.

**Blocking for G2-4 and G2-5:** Even clearing state atomically before commit does not help
because the Copilot Chat hooks fire asynchronously from the VS Code extension side (not from
within the terminal command). By the time `git commit` runs, new Copilot state has already
been written. With `Prompts: 5` observed on the retry, it is clear that every `run_in_terminal`
tool call increments the Copilot session counter.

**Resolution:** G2-4 and G2-5 CANNOT be verified by an AI agent running inside VS Code Copilot
Chat. These two scenarios require **manual human execution** (open a terminal outside VS Code,
clear state, make a plain commit, check no marker). The underlying `resetStateAfterCommit`
behaviour IS verified indirectly by G2-4's first run: the marker showed `copilot` only — no
Claude carryover — confirming the Claude state was correctly reset after G2-3.

**Note:** This is a testing methodology limitation, not a product bug. In real usage a user
would not be simultaneously running Copilot Chat while making a "plain" commit.

---

## Gap 3 — Plan expected token format was inaccurate (DOCUMENTATION ONLY)

**Discovered during:** Gate 2 G2-2 verification
**Plan expected:** `Tokens: input=N output=N`
**Actual format:** `Tokens: claude-opus-4-6: 41k in/298 out (34k cached)`
**Impact:** None — tokens ARE present and non-zero. G2-2 passes on substance. The plan's
expected format string was a rough approximation that did not match `formatMarker`'s output.

---

## Gap 1 — isClaudePath heuristic was too narrow (RESOLVED)

**Discovered during:** Phase 3 test run  
**Test:** `handleStop: reads Claude transcript tokens and models at Stop time`  
**Root cause:** The `handleStop` Claude block used `claudePath.includes('.claude')` to decide whether to invoke `extractFromClaudeTranscript`. In tests, the transcript path is a system `%TEMP%` directory that doesn't contain `.claude` in its path — so the reader was never called.  
**Resolution:** Removed the path-detection heuristic entirely. Both readers (`extractFromCliTranscript` and `extractFromClaudeTranscript`) now always run against `input.transcript_path`. This is safe because the two schemas are disjoint:
- Copilot CLI uses `type:"session.model_change"`, `"assistant.message"`, `"session.shutdown"`
- Claude Code uses `type:"assistant"` (not `"assistant.message"`)

Each reader returns empty for the other's format → no double-counting possible.  
**Commit:** Included in feat commit on `users/dexterman/feature/claudeCodeSupport`.
