/**
 * Core logic tests — run with `bun test`.
 * These exercise the SAME shared core the extension uses, so they guarantee the
 * standalone binary tracks sessions/tokens/markers identically.
 */
import { test, expect, beforeEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    dispatch,
    formatMarker,
    loadState,
    saveState,
    getDataDir,
    resolveOtelDbPath,
    getStatePath,
    getFlagPath,
    type TrackerState,
    type HookInput,
} from "../../../src/hook-handler.ts";

function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

beforeEach(() => {
    // Isolate cross-repo state in a throwaway data dir for every test.
    process.env.AI_TRACKER_DATA_DIR = tmpDir("aitrack-data-");
});

test("getDataDir honors AI_TRACKER_DATA_DIR", () => {
    const dir = tmpDir("aitrack-dd-");
    process.env.AI_TRACKER_DATA_DIR = dir;
    expect(getDataDir()).toBe(dir);
});

test("resolveOtelDbPath honors AI_TRACKER_OTEL_DB when the file exists", () => {
    const dir = tmpDir("aitrack-otel-");
    const dbFile = path.join(dir, "agent-traces.db");
    fs.writeFileSync(dbFile, "");
    process.env.AI_TRACKER_OTEL_DB = dbFile;
    try {
        expect(resolveOtelDbPath()).toBe(dbFile);
    } finally {
        delete process.env.AI_TRACKER_OTEL_DB;
    }
});

test("formatMarker builds the expected marker string", () => {
    const state: TrackerState = {
        promptCount: 2,
        subagentCount: 0,
        mainAgentTypes: ["copilot"],
        subagentTypes: [],
        activeSubagents: 0,
        models: ["claude-sonnet-4-6"],
        subagentModels: [],
        sessionId: "s1",
        sessionIds: ["s1"],
        sessionTranscripts: {},
        stateCreatedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        tokensByModel: {
            "claude-sonnet-4-6": { inputTokens: 48000, outputTokens: 2000, cachedTokens: 41000, reasoningTokens: 0 },
        },
    };
    const marker = formatMarker(state);
    expect(marker).toContain("Impacted by AI");
    expect(marker).toContain("Agent mode: copilot");
    expect(marker).toContain("Model: claude-sonnet-4-6");
    expect(marker).toContain("Prompts: 2");
    expect(marker).toContain("48k in/2k out (41k cached)");
});

test("state round-trips through save/load", () => {
    const gitDir = tmpDir("aitrack-git-");
    const state = loadState(gitDir);
    state.promptCount = 3;
    state.mainAgentTypes.push("copilot");
    saveState(gitDir, state);
    const reloaded = loadState(gitDir);
    expect(reloaded.promptCount).toBe(3);
    expect(reloaded.mainAgentTypes).toContain("copilot");
    expect(fs.existsSync(getStatePath(gitDir))).toBe(true);
});

test("full Copilot session dispatch writes the AI marker flag", () => {
    const gitDir = tmpDir("aitrack-session-");
    const base = { cwd: ".", gitDir, timestamp: new Date().toISOString() };

    dispatch({ ...base, hookEventName: "SessionStart", source: "new", session_id: "t1" } as HookInput);
    dispatch({ ...base, hookEventName: "UserPromptSubmit", session_id: "t1", prompt: "add a feature" } as HookInput);
    dispatch({ ...base, hookEventName: "Stop", session_id: "t1" } as HookInput);

    const flagPath = getFlagPath(gitDir);
    expect(fs.existsSync(flagPath)).toBe(true);
    const flag = fs.readFileSync(flagPath, "utf8");
    expect(flag).toContain("Impacted by AI");
    expect(flag).toContain("Agent mode: copilot");
    expect(flag).toContain("Prompts: 1");
});

test("subagent-delegated prompts are not counted as user prompts", () => {
    const gitDir = tmpDir("aitrack-sub-");
    const base = { cwd: ".", gitDir, timestamp: new Date().toISOString() };

    dispatch({ ...base, hookEventName: "SessionStart", source: "new", session_id: "t2" } as HookInput);
    dispatch({ ...base, hookEventName: "UserPromptSubmit", session_id: "t2", prompt: "top-level" } as HookInput);
    dispatch({ ...base, hookEventName: "SubagentStart", session_id: "t2", agent_type: "Explore" } as HookInput);
    // This prompt arrives while a subagent is active — must NOT increment promptCount.
    dispatch({ ...base, hookEventName: "UserPromptSubmit", session_id: "t2", prompt: "delegated" } as HookInput);
    dispatch({ ...base, hookEventName: "SubagentStop", session_id: "t2", agent_type: "Explore" } as HookInput);
    dispatch({ ...base, hookEventName: "Stop", session_id: "t2" } as HookInput);

    const state = loadState(gitDir);
    expect(state.promptCount).toBe(1);
    expect(state.subagentCount).toBe(1);
    expect(state.subagentTypes).toContain("Explore");
});

test("CommitMsg resets state after consuming it", () => {
    const gitDir = tmpDir("aitrack-commit-");
    const base = { cwd: ".", gitDir, timestamp: new Date().toISOString() };

    dispatch({ ...base, hookEventName: "SessionStart", source: "new", session_id: "t3" } as HookInput);
    dispatch({ ...base, hookEventName: "UserPromptSubmit", session_id: "t3", prompt: "work" } as HookInput);
    dispatch({ ...base, hookEventName: "Stop", session_id: "t3" } as HookInput);
    // Simulate the git hook firing CommitMsg.
    dispatch({ hookEventName: "CommitMsg", cwd: ".", gitDir, timestamp: new Date().toISOString() } as HookInput);

    const state = loadState(gitDir);
    expect(state.promptCount).toBe(0);
    expect(state.mainAgentTypes.length).toBe(0);
});
