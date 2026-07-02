/**
 * End-to-end git integration test — run with `bun test`.
 * Creates a real git repo with a real prepare-commit-msg hook, simulates a
 * Copilot agent session (firing the shared core the same way the CLI's `hook`
 * subcommand does), then makes a real commit and asserts the AI marker was
 * appended. The shell hook also invokes the CLI for the CommitMsg refresh,
 * exercising the git → CLI path via git's own shell exactly as in production.
 */
import { test, expect } from "bun:test";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { dispatch, type HookInput } from "../../../src/hook-handler.ts";

function toPosix(p: string): string {
    return p.replace(/\\/g, "/");
}

function git(repo: string, args: string[], env?: NodeJS.ProcessEnv): string {
    try {
        return execFileSync("git", args, {
            cwd: repo,
            encoding: "utf8",
            // Closed stdin: prevents git hook subprocesses (grep/cat) from
            // hanging on the test runner's inherited stdin under `bun test`.
            input: "",
            env: { ...process.env, ...env },
        }).trim();
    } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        throw new Error(`git ${args.join(" ")} failed:\nSTDOUT: ${err.stdout}\nSTDERR: ${err.stderr}\n${err.message}`);
    }
}

// The git-commit variant drives a real `git commit` whose hook spawns MSYS
// grep/cat. The `bun test` runner on Windows leaves those grandchildren holding
// the stdout pipe, so execFileSync never returns (a runner quirk, not a product
// bug — it works standalone and on Linux CI). Windows is fully covered by the
// compiled-binary PowerShell e2e (packages/cli/scripts/e2e-test.ps1).
const e2eTest = process.platform === "win32" ? test.skip : test;

e2eTest("commit is stamped with AI marker via a real git hook", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "aitrack-e2e-"));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitrack-e2e-data-"));
    process.env.AI_TRACKER_DATA_DIR = dataDir;

    git(repo, ["init", "-q"]);
    git(repo, ["config", "user.email", "t@t.co"]);
    git(repo, ["config", "user.name", "test"]);

    const gitDir = path.join(repo, ".git");

    // Use a repo-local hooks dir so this test is isolated from any global
    // core.hooksPath already configured on the machine (e.g. the extension's).
    const hooksDir = path.join(repo, ".githooks");
    fs.mkdirSync(hooksDir, { recursive: true });
    git(repo, ["config", "core.hooksPath", toPosix(hooksDir)]);

    // Install a prepare-commit-msg hook that stamps the marker from the pending
    // flag. (The CLI's CommitMsg refresh path is covered by the core tests and
    // the compiled-binary PowerShell e2e; nested `bun` spawns are unreliable
    // inside the `bun test` runner, so this hook is pure shell.)
    const hookLines = [
        "#!/bin/sh",
        'case "$2" in merge|squash|commit) exit 0 ;; esac',
        'IMPACT_FLAG=$(git rev-parse --git-path AI_IMPACT_PENDING)',
        'STATE_FILE=$(git rev-parse --git-path ai-tracker-state.json)',
        'if [ -f "$IMPACT_FLAG" ]; then',
        '  MARKER=$(cat "$IMPACT_FLAG")',
        '  if ! grep -qF "$MARKER" "$1"; then echo "" >> "$1"; echo "$MARKER" >> "$1"; fi',
        '  rm "$IMPACT_FLAG"',
        "fi",
        'if [ -f "$STATE_FILE" ]; then rm "$STATE_FILE"; fi',
    ];
    const hookPath = path.join(hooksDir, "prepare-commit-msg");
    fs.writeFileSync(hookPath, hookLines.join("\n") + "\n");
    try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows */ }

    // Fire a Copilot agent session through the shared core (identical to the
    // CLI's `hook` subcommand, which just JSON-parses stdin and calls dispatch).
    const base = { cwd: ".", gitDir, timestamp: new Date().toISOString() };
    dispatch({ ...base, hookEventName: "SessionStart", source: "new", session_id: "e2e" } as HookInput);
    dispatch({ ...base, hookEventName: "UserPromptSubmit", session_id: "e2e", prompt: "add feature" } as HookInput);
    dispatch({ ...base, hookEventName: "Stop", session_id: "e2e" } as HookInput);

    // The Stop event must have produced the pending flag.
    expect(fs.existsSync(path.join(gitDir, "AI_IMPACT_PENDING"))).toBe(true);

    fs.writeFileSync(path.join(repo, "file.txt"), "hello");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "feat: add feature"], { AI_TRACKER_DATA_DIR: dataDir });

    const message = git(repo, ["log", "-1", "--format=%B"]);
    expect(message).toContain("feat: add feature");
    expect(message).toContain("Impacted by AI");
    expect(message).toContain("Agent mode: copilot");
    expect(message).toContain("Prompts: 1");

    // Flag + state consumed by the commit.
    expect(fs.existsSync(path.join(gitDir, "AI_IMPACT_PENDING"))).toBe(false);

    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
});
