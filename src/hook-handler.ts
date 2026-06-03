#!/usr/bin/env node
/**
 * AI Commit Tracker - Copilot Hook Handler
 * 
 * Standalone Node.js script invoked by VS Code Copilot Hooks.
 * Receives JSON on stdin, dispatches by hookEventName.
 * Tracks agent sessions, prompt counts, and model info per-repo,
 * accumulating state until consumed by the git commit-msg hook.
 * 
 * Hook events handled:
 * - SessionStart: Initialize/load per-repo tracking state
 * - UserPromptSubmit: Increment prompt count
 * - SubagentStart: Record agent type/name
 * - Stop: Parse transcript for model, write AI_IMPACT_PENDING flag
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HookInput {
    timestamp: string;
    cwd: string;
    // VS Code sends snake_case; we accept both
    sessionId?: string;
    session_id?: string;
    hookEventName?: string;
    hook_event_name?: string;
    transcript_path?: string;
    // SessionStart
    source?: string;
    // UserPromptSubmit
    prompt?: string;
    // SubagentStart / SubagentStop
    agent_id?: string;
    agent_type?: string;
    // Stop
    stop_hook_active?: boolean;
    // PreToolUse / PostToolUse
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    // CommitMsg (injected by commit-msg shell hook, not VS Code)
    gitDir?: string;
}

export interface TrackerState {
    promptCount: number;
    subagentCount: number;
    mainAgentTypes: string[];
    subagentTypes: string[];
    activeSubagents: number;
    models: string[];
    subagentModels: string[];
    sessionId: string | null;
    /** All session IDs that contributed since the last commit (for transcript reading) */
    sessionIds: string[];
    /** Claude transcript paths keyed by session ID (persisted at SessionStart/Stop for CommitMsg-time reading) */
    sessionTranscripts: Record<string, string>;
    stateCreatedAt: string;
    lastUpdated: string;
    // Token usage from OTEL SQLite DB (populated at Stop event), keyed by response model
    tokensByModel: Record<string, TokenTotals>;
}

// ─── Git Discovery ───────────────────────────────────────────────────────────

/**
 * Find the .git directory for the given working directory.
 */
export function findGitDir(cwd: string): string | null {
    // Check for .git directory directly
    const dotGit = path.join(cwd, '.git');
    if (fs.existsSync(dotGit)) {
        // Could be a file (worktree) or directory
        if (fs.statSync(dotGit).isDirectory()) {
            return dotGit;
        }
        // Worktree: .git is a file pointing to the real git dir
        const content = fs.readFileSync(dotGit, 'utf8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/);
        if (match) {
            const resolved = path.resolve(cwd, match[1]);
            if (fs.existsSync(resolved)) {
                return resolved;
            }
        }
    }

    // Fallback: use git rev-parse
    try {
        const gitDir = execSync('git rev-parse --git-dir', {
            cwd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        const resolved = path.resolve(cwd, gitDir);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    } catch {
        // Not a git repository
    }

    return null;
}

/**
 * Fallback git dir resolution for when hook events arrive with a non-repo cwd
 * (e.g. Copilot CLI running from C:\WINDOWS\system32).
 *
 * Reads the active-workspace.json file written by the VS Code extension, which
 * lists all currently open workspace root paths. If exactly one is a git repo
 * we use it. If there are multiple we pick the one with the most recent
 * ai-tracker-state.json — i.e. the repo with live AI activity.
 */
export function findGitDirFromActiveWorkspace(): string | null {
    try {
        // hook-handler.js lives at: globalStorage/copilot-hooks/hook-handler.js
        // active-workspace.json is at: globalStorage/active-workspace.json
        const activeWorkspacePath = path.join(__dirname, '..', 'active-workspace.json');
        if (!fs.existsSync(activeWorkspacePath)) { return null; }

        const data = JSON.parse(fs.readFileSync(activeWorkspacePath, 'utf8')) as { workspaces?: string[] };
        const workspaces: string[] = data.workspaces || [];
        if (workspaces.length === 0) { return null; }

        const candidates: Array<{ gitDir: string; mtime: number }> = [];
        for (const ws of workspaces) {
            const gitDir = findGitDir(ws);
            if (!gitDir) { continue; }
            const stateFile = path.join(gitDir, 'ai-tracker-state.json');
            const mtime = fs.existsSync(stateFile)
                ? fs.statSync(stateFile).mtimeMs
                : 0;
            candidates.push({ gitDir, mtime });
        }

        if (candidates.length === 0) { return null; }
        // Prefer the repo with the most recently touched state file
        candidates.sort((a, b) => b.mtime - a.mtime);
        return candidates[0].gitDir;
    } catch {
        return null;
    }
}

/**
 * When commit-msg fires for a repo that has no accumulated state, check if
 * state was accidentally written to another workspace (due to cwd fallback).
 * If found, move it to the correct repo and clean up the source.
 */
function migrateStateFromOtherWorkspaces(targetGitDir: string): TrackerState | null {
    try {
        const activeWorkspacePath = path.join(__dirname, '..', 'active-workspace.json');
        if (!fs.existsSync(activeWorkspacePath)) { return null; }

        const data = JSON.parse(fs.readFileSync(activeWorkspacePath, 'utf8')) as { workspaces?: string[] };
        const workspaces = data.workspaces || [];

        const targetNorm = path.normalize(targetGitDir).toLowerCase();
        let bestState: TrackerState | null = null;
        let bestMtime = 0;
        let bestGitDir: string | null = null;

        for (const ws of workspaces) {
            const gitDir = findGitDir(ws);
            if (!gitDir) { continue; }
            if (path.normalize(gitDir).toLowerCase() === targetNorm) { continue; }

            const stateFile = path.join(gitDir, 'ai-tracker-state.json');
            if (!fs.existsSync(stateFile)) { continue; }

            const mtime = fs.statSync(stateFile).mtimeMs;
            const state = loadState(gitDir);
            // Only consider state that has actual activity
            if (state.promptCount === 0 && state.mainAgentTypes.length === 0) { continue; }

            if (mtime > bestMtime) {
                bestMtime = mtime;
                bestState = state;
                bestGitDir = gitDir;
            }
        }

        if (bestState && bestGitDir) {
            // Move state to the correct repo
            saveState(targetGitDir, bestState);
            writeFlagEagerly(targetGitDir, bestState);
            // Clean up the misplaced state
            const wrongStateFile = path.join(bestGitDir, 'ai-tracker-state.json');
            const wrongFlagFile = path.join(bestGitDir, 'AI_IMPACT_PENDING');
            try { fs.unlinkSync(wrongStateFile); } catch { /* ok */ }
            try { fs.unlinkSync(wrongFlagFile); } catch { /* ok */ }
            return bestState;
        }
    } catch { /* best effort */ }
    return null;
}

// ─── Pending State (CLI events with no gitDir) ──────────────────────────────

/**
 * Returns a directory in globalStorage used to accumulate state from hook events
 * that arrive without a valid git repo context (e.g. Copilot CLI with cwd=homedir).
 * At CommitMsg time, this pending state is consumed and moved to the correct repo.
 */
export function getPendingStateDir(): string {
    const dir = path.join(__dirname, '..', 'pending');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

// ─── Session-to-Repo Mapping ─────────────────────────────────────────────────

const SESSION_MAP_FILENAME = 'session-repo-map.json';

function getSessionMapPath(): string {
    return path.join(__dirname, '..', SESSION_MAP_FILENAME);
}

function saveSessionRepo(sessionId: string, gitDir: string): void {
    try {
        const mapPath = getSessionMapPath();
        let map: Record<string, string> = {};
        if (fs.existsSync(mapPath)) {
            map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        }
        map[sessionId] = gitDir;
        fs.writeFileSync(mapPath, JSON.stringify(map));
    } catch { /* best effort */ }
}

function lookupSessionRepo(sessionId: string): string | null {
    try {
        const mapPath = getSessionMapPath();
        if (!fs.existsSync(mapPath)) { return null; }
        const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        return map[sessionId] || null;
    } catch { return null; }
}

function clearSessionRepo(sessionId: string): void {
    try {
        const mapPath = getSessionMapPath();
        if (!fs.existsSync(mapPath)) { return; }
        const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        delete map[sessionId];
        fs.writeFileSync(mapPath, JSON.stringify(map));
    } catch { /* best effort */ }
}

// ─── State Management ────────────────────────────────────────────────────────

const STATE_FILENAME = 'ai-tracker-state.json';
const FLAG_FILENAME = 'AI_IMPACT_PENDING';

export function getStatePath(gitDir: string): string {
    return path.join(gitDir, STATE_FILENAME);
}

export function getFlagPath(gitDir: string): string {
    return path.join(gitDir, FLAG_FILENAME);
}

/**
 * Convert an ISO timestamp (UTC) to the local-time format used in VS Code log files.
 * Log format: "2026-04-19 13:12:00.000"
 */
function isoToLogTimestamp(iso: string): string {
    const d = new Date(iso);
    const pad = (n: number, len = 2) => String(n).padStart(len, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function loadState(gitDir: string): TrackerState {
    const statePath = getStatePath(gitDir);
    if (fs.existsSync(statePath)) {
        try {
            const raw = fs.readFileSync(statePath, 'utf8');
            const parsed = JSON.parse(raw) as TrackerState;
            // Ensure new fields are arrays (backward compat)
            if (!Array.isArray(parsed.mainAgentTypes)) {
                parsed.mainAgentTypes = [];
            }
            if (!Array.isArray(parsed.subagentTypes)) {
                // Migrate from old agentTypes field
                parsed.subagentTypes = Array.isArray((parsed as any).agentTypes) ? (parsed as any).agentTypes : [];
            }
            // Ensure new fields have defaults for backward compat
            if (typeof parsed.subagentCount !== 'number') {
                parsed.subagentCount = 0;
            }
            if (typeof parsed.activeSubagents !== 'number') {
                parsed.activeSubagents = 0;
            }
            if (!Array.isArray(parsed.models)) {
                // Migrate from old single model field
                parsed.models = (parsed as any).model ? [(parsed as any).model] : [];
            }
            if (typeof parsed.sessionId !== 'string') {
                parsed.sessionId = null;
            }
            if (!Array.isArray(parsed.sessionIds)) {
                parsed.sessionIds = parsed.sessionId ? [parsed.sessionId] : [];
            }
            if (typeof parsed.sessionTranscripts !== 'object' || parsed.sessionTranscripts === null) {
                parsed.sessionTranscripts = {};
            }
            if (!Array.isArray(parsed.subagentModels)) {
                parsed.subagentModels = [];
            }
            if (typeof parsed.stateCreatedAt !== 'string') {
                parsed.stateCreatedAt = parsed.lastUpdated || new Date().toISOString();
            }
            // Backward compat: older state files may have flat token fields or no token data
            if (typeof parsed.tokensByModel !== 'object' || parsed.tokensByModel === null) {
                const byModel: Record<string, TokenTotals> = {};
                const legacy = parsed as unknown as Record<string, number>;
                if ((legacy['inputTokens'] ?? 0) > 0) {
                    byModel['unknown'] = {
                        inputTokens: legacy['inputTokens'] ?? 0,
                        outputTokens: legacy['outputTokens'] ?? 0,
                        cachedTokens: legacy['cachedTokens'] ?? 0,
                        reasoningTokens: legacy['reasoningTokens'] ?? 0,
                    };
                }
                parsed.tokensByModel = byModel;
            }
            return parsed;
        } catch {
            // Corrupted state file, start fresh
        }
    }
    return {
        promptCount: 0,
        subagentCount: 0,
        mainAgentTypes: [],
        subagentTypes: [],
        activeSubagents: 0,
        models: [],
        subagentModels: [],
        sessionId: null,
        sessionIds: [],
        sessionTranscripts: {},
        stateCreatedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        tokensByModel: {},
    };
}

export function saveState(gitDir: string, state: TrackerState): void {
    state.lastUpdated = new Date().toISOString();
    const statePath = getStatePath(gitDir);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ─── Transcript Parsing ─────────────────────────────────────────────────────

export interface TranscriptMetadata {
    model: string | null;
    producer: string | null;
}

/**
 * Best-effort extraction of metadata from transcript file.
 * Transcript is JSONL (one JSON object per line).
 * Extracts:
 * - model: not currently present in transcripts, but we scan just in case
 * - producer: e.g. "copilot-agent" from session.start entry
 */
export function extractTranscriptMetadata(transcriptPath: string): TranscriptMetadata {
    const result: TranscriptMetadata = { model: null, producer: null };

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        return result;
    }

    try {
        const content = fs.readFileSync(transcriptPath, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
            try {
                const entry = JSON.parse(line);

                // Extract producer from session.start
                if (entry.type === 'session.start' && entry.data?.producer) {
                    result.producer = entry.data.producer;
                }

                // Look for model field (future-proofing)
                if (entry.data) {
                    const model = findModelInObject(entry.data, 0);
                    if (model) {
                        result.model = model;
                    }
                }
            } catch {
                // Skip unparseable lines
            }

            // Stop early if we found everything
            if (result.model && result.producer) {
                break;
            }
        }
    } catch {
        // Can't read transcript, skip
    }

    return result;
}

function findModelInObject(obj: unknown, depth: number = 0): string | null {
    if (depth > 5 || typeof obj !== 'object' || obj === null) {
        return null;
    }

    const record = obj as Record<string, unknown>;

    // Check direct model fields
    for (const key of ['model', 'modelId', 'model_id']) {
        if (typeof record[key] === 'string' && record[key]) {
            return record[key] as string;
        }
    }

    // Recurse into nested objects and arrays
    for (const value of Object.values(record)) {
        if (Array.isArray(value)) {
            for (const item of value) {
                const result = findModelInObject(item, depth + 1);
                if (result) {
                    return result;
                }
            }
        } else if (typeof value === 'object' && value !== null) {
            const result = findModelInObject(value, depth + 1);
            if (result) {
                return result;
            }
        }
    }

    return null;
}

// ─── Copilot CLI Transcript Parsing ──────────────────────────────────────────

/**
 * Extract model and token data from a Copilot CLI session transcript.
 * The transcript is at ~/.copilot/session-state/<session_id>/events.jsonl
 * and is written incrementally during the session.
 *
 * At CommitMsg time (before Stop fires), we can get:
 * - Model name from session.model_change event (written at session start)
 * - Model name from assistant.message entries
 *
 * At Stop time, session.shutdown has full token breakdown per model.
 */
export function extractFromCliTranscript(sessionId: string, transcriptPath?: string): {
    models: string[];
    tokensByModel: Record<string, TokenTotals>;
} {
    const result: { models: string[]; tokensByModel: Record<string, TokenTotals> } = {
        models: [],
        tokensByModel: {},
    };

    // Derive transcript path from session ID if not provided
    const tp = transcriptPath || path.join(os.homedir(), '.copilot', 'session-state', sessionId, 'events.jsonl');
    if (!fs.existsSync(tp)) { return result; }

    try {
        const content = fs.readFileSync(tp, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim()) { continue; }
            try {
                const entry = JSON.parse(line);
                // Model from session.model_change
                if (entry.type === 'session.model_change' && entry.data?.newModel) {
                    const model = entry.data.newModel;
                    if (!result.models.includes(model)) { result.models.push(model); }
                }
                // Model from assistant.message
                if (entry.type === 'assistant.message' && entry.data?.model) {
                    const model = entry.data.model;
                    if (!result.models.includes(model)) { result.models.push(model); }
                }
                // Full metrics from session.shutdown (only available after Stop)
                if (entry.type === 'session.shutdown' && entry.data?.modelMetrics) {
                    const metrics = entry.data.modelMetrics as Record<string, {
                        usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number };
                    }>;
                    for (const [model, data] of Object.entries(metrics)) {
                        if (data.usage) {
                            result.tokensByModel[model] = {
                                inputTokens: data.usage.inputTokens || 0,
                                outputTokens: data.usage.outputTokens || 0,
                                cachedTokens: data.usage.cacheReadTokens || 0,
                                reasoningTokens: data.usage.reasoningTokens || 0,
                            };
                            if (!result.models.includes(model)) { result.models.push(model); }
                        }
                    }
                }
            } catch { /* skip unparseable lines */ }
        }
    } catch { /* best effort */ }

    return result;
}

// ─── Claude Code Transcript Parsing ────────────────────────────────────────

/**
 * Derive the expected Claude Code transcript path for a session ID and cwd.
 * Claude Code stores transcripts at:
 *   ~/.claude/projects/<cwd-dashified>/<sessionId>.jsonl
 * where cwd-dashified replaces [:\/] with '-'.
 */
export function deriveClaudeTranscriptPath(sessionId: string, cwd?: string): string {
    const home = os.homedir();
    if (cwd) {
        const dashified = cwd.replace(/[:\\/]/g, '-');
        return path.join(home, '.claude', 'projects', dashified, `${sessionId}.jsonl`);
    }
    // Without cwd, search all project dirs for a matching session file
    const projectsDir = path.join(home, '.claude', 'projects');
    if (fs.existsSync(projectsDir)) {
        for (const project of fs.readdirSync(projectsDir)) {
            const candidate = path.join(projectsDir, project, `${sessionId}.jsonl`);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return '';
}

/**
 * Extract model names and per-turn token usage from a Claude Code transcript.
 *
 * Claude Code transcript = ~/.claude/projects/<cwd-dashified>/<sessionId>.jsonl
 * Schema (per-turn, unlike Copilot CLI which only has totals at shutdown):
 *   type:"assistant" entries carry message.model and message.usage with:
 *     input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens
 *
 * Token mapping (per plan decision 1):
 *   input_tokens + cache_creation_input_tokens → inputTokens  (cache creation counts as input cost)
 *   output_tokens                              → outputTokens
 *   cache_read_input_tokens                    → cachedTokens
 *   (no reasoning field in Claude Code today)  → reasoningTokens = 0
 *
 * Returns same shape as extractFromCliTranscript for drop-in use.
 */
export function extractFromClaudeTranscript(sessionId: string, transcriptPath?: string): {
    models: string[];
    tokensByModel: Record<string, TokenTotals>;
} {
    const result: { models: string[]; tokensByModel: Record<string, TokenTotals> } = {
        models: [],
        tokensByModel: {},
    };

    // Prefer explicit path, then derive by searching ~/.claude/projects/
    const tp = transcriptPath || deriveClaudeTranscriptPath(sessionId);
    if (!tp || !fs.existsSync(tp)) { return result; }

    try {
        const content = fs.readFileSync(tp, 'utf8');
        for (const line of content.split('\n')) {
            if (!line.trim()) { continue; }
            try {
                const entry = JSON.parse(line);
                // Only process assistant turns
                if (entry.type !== 'assistant') { continue; }
                const msg = entry.message;
                if (!msg) { continue; }

                // Extract model — skip synthetic/error entries
                const model: string = msg.model || '';
                if (!model || model === '<synthetic>') { continue; }

                if (!result.models.includes(model)) { result.models.push(model); }

                // Accumulate token usage per model
                const usage = msg.usage;
                if (usage) {
                    const inputTokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
                    const outputTokens = usage.output_tokens || 0;
                    const cachedTokens = usage.cache_read_input_tokens || 0;

                    if (inputTokens > 0 || outputTokens > 0) {
                        const existing = result.tokensByModel[model];
                        if (existing) {
                            existing.inputTokens  += inputTokens;
                            existing.outputTokens += outputTokens;
                            existing.cachedTokens += cachedTokens;
                        } else {
                            result.tokensByModel[model] = {
                                inputTokens,
                                outputTokens,
                                cachedTokens,
                                reasoningTokens: 0,
                            };
                        }
                    }
                }
            } catch { /* skip unparseable lines */ }
        }
    } catch { /* best effort */ }

    return result;
}

// ─── Copilot Chat Log Parsing ────────────────────────────────────────────────

/**
 * Scans the VS Code Copilot Chat output log file for models used in the session.
 * Uses the session_id to find the correct VS Code window, then reads only that
 * window's log file for model entries.
 * 
 * @param logsBaseDir Optional override for the logs base directory (used in tests)
 * @param sessionId The Copilot session ID to scope to the correct window
 */
export function extractModelFromCopilotLog(logsBaseDir?: string, sessionId?: string | null, afterTimestamp?: string): LogModels {
    const allModels: string[] = [];
    const allSubagentModels: string[] = [];
    try {
        const baseDirs = logsBaseDir
            ? [logsBaseDir]
            : getVSCodeLogDirs();

        for (const logsDir of baseDirs) {
            if (!fs.existsSync(logsDir)) { continue; }

            // Find the most recent session folder (YYYYMMDDTHHMMSS format)
            const folders = fs.readdirSync(logsDir)
                .filter(f => /^\d{8}T\d{6}$/.test(f))
                .sort()
                .reverse();
            if (folders.length === 0) { continue; }

            const latestFolder = path.join(logsDir, folders[0]);
            const result = searchLogFolderForModel(latestFolder, sessionId, afterTimestamp);
            for (const m of result.models) {
                if (!allModels.includes(m)) { allModels.push(m); }
            }
            for (const m of result.subagentModels) {
                if (!allSubagentModels.includes(m)) { allSubagentModels.push(m); }
            }
        }
    } catch {
        // Best-effort: any failure is silently ignored
    }
    return { models: allModels, subagentModels: allSubagentModels };
}

function getVSCodeLogDirs(): string[] {
    const home = os.homedir();
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        return [
            path.join(appData, 'Code - Insiders', 'logs'),
            path.join(appData, 'Code', 'logs'),
        ];
    } else if (process.platform === 'darwin') {
        return [
            path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'logs'),
            path.join(home, 'Library', 'Application Support', 'Code', 'logs'),
        ];
    } else {
        return [
            path.join(home, '.config', 'Code - Insiders', 'logs'),
            path.join(home, '.config', 'Code', 'logs'),
        ];
    }
}

function searchLogFolderForModel(dir: string, sessionId?: string | null, afterTimestamp?: string): LogModels {
    const models: string[] = [];
    const subagentModels: string[] = [];

    function mergeResult(result: LogModels): void {
        for (const m of result.models) { if (!models.includes(m)) { models.push(m); } }
        for (const m of result.subagentModels) { if (!subagentModels.includes(m)) { subagentModels.push(m); } }
    }

    // If we have a session_id, find the specific window that ran this session
    // by checking which "GitHub Copilot Chat Hooks.log" contains the session_id
    if (sessionId) {
        try {
            const windowDirs = fs.readdirSync(dir, { withFileTypes: true })
                .filter(e => e.isDirectory() && e.name.startsWith('window'));

            for (const windowDir of windowDirs) {
                const hooksLog = path.join(dir, windowDir.name, 'exthost', 'GitHub.copilot-chat', 'GitHub Copilot Chat Hooks.log');
                try {
                    if (fs.existsSync(hooksLog)) {
                        const content = fs.readFileSync(hooksLog, 'utf8');
                        if (content.includes(sessionId)) {
                            // Found our window — read its Chat log for models
                            const chatLog = path.join(dir, windowDir.name, 'exthost', 'GitHub.copilot-chat', 'GitHub Copilot Chat.log');
                            mergeResult(parseModelFromLogFile(chatLog, afterTimestamp));
                            return { models, subagentModels };
                        }
                    }
                } catch { /* skip unreadable */ }
            }
        } catch { /* fall through to recursive scan */ }
    }

    // Fallback: scan all windows (no session_id or window not found)
    function recurse(d: string): void {
        try {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    recurse(full);
                } else if (entry.name === 'GitHub Copilot Chat.log') {
                    mergeResult(parseModelFromLogFile(full, afterTimestamp));
                }
            }
        } catch { /* ignore unreadable dirs */ }
    }

    recurse(dir);
    return { models, subagentModels };
}

export interface LogModels {
    models: string[];
    subagentModels: string[];
}

export function parseModelFromLogFile(filePath: string, afterTimestamp?: string): LogModels {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const models: string[] = [];
        const subagentModels: string[] = [];
        // Log line timestamp format: "2026-04-19 13:12:00.000"
        const tsRegex = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})/;
        for (const line of content.split('\n')) {
            // Skip lines before the cutoff timestamp (state creation time)
            if (afterTimestamp) {
                const tsMatch = line.match(tsRegex);
                if (tsMatch && tsMatch[1] < afterTimestamp) { continue; }
            }
            // User-selected model: [panel/editAgent]
            const main = line.match(/ccreq:[a-f0-9]+\.copilotmd \| success \| ([^\s]+?)(?:\s+->.*?)? \| \d+ms \| \[panel\/editAgent\]/);
            if (main && !models.includes(main[1])) { models.push(main[1]); continue; }
            // Sub-agent model: [tool/runSubagent*]
            const sub = line.match(/ccreq:[a-f0-9]+\.copilotmd \| success \| ([^\s]+?)(?:\s+->.*?)? \| \d+ms \| \[tool\/runSubagent[^\]]*\]/);
            if (sub && !subagentModels.includes(sub[1]) && !models.includes(sub[1])) { subagentModels.push(sub[1]); }
        }
        return { models, subagentModels };
    } catch {
        return { models: [], subagentModels: [] };
    }
}

// ─── OTEL Token Query ────────────────────────────────────────────────────────

export interface TokenTotals {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    reasoningTokens: number;
}

/**
 * Query the Copilot extension's local OTEL SQLite DB for token usage
 * accumulated during the given VS Code session (chat_session_id),
 * broken down per response model.
 *
 * The DB is created unconditionally on VS Code start; it is populated with
 * span data only when `github.copilot.chat.otel.dbSpanExporter.enabled = true`.
 *
 * Path derivation: hook-handler.js lives at
 *   <globalStorage>/yoavlax.ai-contribution-tracker/copilot-hooks/hook-handler.js
 * The Copilot DB is at:
 *   <globalStorage>/github.copilot-chat/agent-traces.db
 * i.e. two levels up, then into github.copilot-chat/.
 */
export function queryTokensFromOtel(sessionId: string, afterMs: number): Record<string, TokenTotals> | null {
    const dbPath = path.join(__dirname, '..', '..', 'github.copilot-chat', 'agent-traces.db');
    if (!fs.existsSync(dbPath)) {
        return null;
    }

    try {
        // node:sqlite is built-in since Node 22 — no npm dependency needed
        const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
        const db = new DatabaseSync(dbPath, { readOnly: true });

        const rows = db.prepare(
            `SELECT
               response_model                       AS model,
               COALESCE(SUM(input_tokens), 0)       AS inputTokens,
               COALESCE(SUM(output_tokens), 0)      AS outputTokens,
               COALESCE(SUM(cached_tokens), 0)      AS cachedTokens,
               COALESCE(SUM(reasoning_tokens), 0)   AS reasoningTokens
             FROM spans
             WHERE (chat_session_id = ? OR conversation_id = ?)
               AND operation_name  = 'chat'
               AND response_model  IS NOT NULL
               AND start_time_ms  >= ?
             GROUP BY response_model`
        ).all(sessionId, sessionId, afterMs) as Array<{ model: string; inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number }>;

        db.close();

        if (rows.length === 0) {
            return null; // DB present but no data yet (dbSpanExporter disabled or no activity)
        }

        const result: Record<string, TokenTotals> = {};
        for (const row of rows) {
            if (row.inputTokens > 0 || row.outputTokens > 0) {
                result[row.model] = {
                    inputTokens: row.inputTokens,
                    outputTokens: row.outputTokens,
                    cachedTokens: row.cachedTokens,
                    reasoningTokens: row.reasoningTokens,
                };
            }
        }

        return Object.keys(result).length > 0 ? result : null;
    } catch {
        // node:sqlite unavailable or DB locked — skip silently
        return null;
    }
}

// ─── Marker Formatting ──────────────────────────────────────────────────────

export function formatMarker(state: TrackerState): string {
    const parts: string[] = [];

    // Main agent mode (top-level agent)
    const uniqueMainAgents = [...new Set(state.mainAgentTypes)];
    if (uniqueMainAgents.length > 0) {
        parts.push(`Agent mode: ${uniqueMainAgents.join(', ')}`);
    }

    // Model(s)
    if (state.models && state.models.length > 0) {
        parts.push(`Model: ${state.models.join(', ')}`);
    }

    // Prompt count (user prompts only)
    if (state.promptCount > 0) {
        parts.push(`Prompts: ${state.promptCount}`);
    }

    // Sub-agent mode (types of subagents used)
    const uniqueSubAgents = [...new Set(state.subagentTypes)];
    if (uniqueSubAgents.length > 0) {
        parts.push(`Sub-agents mode: ${uniqueSubAgents.join(', ')}`);
    }

    // Sub-agent models
    const uniqueSubModels = [...new Set(state.subagentModels || [])];
    if (uniqueSubModels.length > 0) {
        parts.push(`sub-Agent models: ${uniqueSubModels.join(', ')}`);
    }

    // Sub-agent invocation count
    if (state.subagentCount > 0) {
        parts.push(`sub-Agent prompts: ${state.subagentCount}`);
    }

    // Token usage per model (from OTEL DB — only shown when data is available)
    const modelEntries = Object.entries(state.tokensByModel || {});
    if (modelEntries.length > 0) {
        const formatK = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
        const modelParts = modelEntries.map(([model, t]) => {
            let s = `${model}: ${formatK(t.inputTokens)} in/${formatK(t.outputTokens)} out`;
            if (t.cachedTokens > 0) { s += ` (${formatK(t.cachedTokens)} cached)`; }
            if (t.reasoningTokens > 0) { s += ` +${formatK(t.reasoningTokens)} reasoning`; }
            return s;
        });
        parts.push(`Tokens: ${modelParts.join(' | ')}`);
    }

    if (parts.length > 0) {
        return `Impacted by AI (${parts.join(' | ')})`;
    }

    return 'Impacted by AI';
}

/**
 * Eagerly write/update the AI_IMPACT_PENDING flag with current accumulated state.
 * Called at SubagentStop and UserPromptSubmit so the flag is present if a commit
 * happens BEFORE the Stop event fires (which is the common case when the agent
 * runs git-commit as part of its response).
 *
 * Merge rules (same as handleStop):
 * - If flag already contains model info, don't downgrade it.
 * - If flag contains "Inline" marker, merge inline + agent data.
 * - Otherwise overwrite with current state marker.
 */
function writeFlagEagerly(gitDir: string, state: TrackerState): void {
    if (state.promptCount === 0 && state.mainAgentTypes.length === 0 &&
        state.subagentTypes.length === 0 && state.subagentCount === 0) {
        return; // Nothing meaningful to write yet
    }

    const flagPath = getFlagPath(gitDir);
    const newMarker = formatMarker(state);

    if (fs.existsSync(flagPath)) {
        const existing = fs.readFileSync(flagPath, 'utf8').trim();
        // Don't overwrite a flag that already has model info (written by Stop)
        if (existing.includes('Model:')) {
            return;
        }
        if (existing.includes('Inline')) {
            // Merge: inline flag present — reuse the same merge logic
            const agentParts: string[] = [];
            const uniqueMain = [...new Set(state.mainAgentTypes)];
            if (uniqueMain.length > 0) { agentParts.push(`Agent mode: ${uniqueMain.join(', ')}`); }
            if (state.models && state.models.length > 0) { agentParts.push(`Model: ${state.models.join(', ')}`); }
            if (state.promptCount > 0) { agentParts.push(`Prompts: ${state.promptCount}`); }
            const uniqueSub = [...new Set(state.subagentTypes)];
            if (uniqueSub.length > 0) { agentParts.push(`Sub-agents mode: ${uniqueSub.join(', ')}`); }
            const uniqueSubModels = [...new Set(state.subagentModels || [])];
            if (uniqueSubModels.length > 0) { agentParts.push(`sub-Agent models: ${uniqueSubModels.join(', ')}`); }
            if (state.subagentCount > 0) { agentParts.push(`sub-Agent prompts: ${state.subagentCount}`); }
            const modelEntries = Object.entries(state.tokensByModel || {});
            if (modelEntries.length > 0) {
                const formatK = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
                const modelParts = modelEntries.map(([model, t]) => {
                    let s = `${model}: ${formatK(t.inputTokens)} in/${formatK(t.outputTokens)} out`;
                    if (t.cachedTokens > 0) { s += ` (${formatK(t.cachedTokens)} cached)`; }
                    if (t.reasoningTokens > 0) { s += ` +${formatK(t.reasoningTokens)} reasoning`; }
                    return s;
                });
                agentParts.push(`Tokens: ${modelParts.join(' | ')}`);
            }
            const combined = agentParts.length > 0
                ? `Impacted by AI (Inline + ${agentParts.join(' | ')})`
                : 'Impacted by AI (Inline)';
            fs.writeFileSync(flagPath, combined);
        } else {
            fs.writeFileSync(flagPath, newMarker);
        }
    } else {
        fs.writeFileSync(flagPath, newMarker);
    }
}

// ─── Event Handlers ─────────────────────────────────────────────────────────

export function handleSessionStart(input: HookInput, gitDir: string): void {
    const state = loadState(gitDir);
    // Reset active subagent count at session start (safety measure)
    state.activeSubagents = 0;
    // Record session ID for scoping log file searches to correct window
    const sid = input.sessionId || input.session_id;
    if (sid) {
        state.sessionId = sid;
        // Track all sessions since last commit for transcript reading
        if (!state.sessionIds.includes(sid)) {
            state.sessionIds.push(sid);
        }
    }
    // Normalize source:
    //   Copilot CLI reports "new"         → "copilot"
    //   Claude Code reports "startup" or entrypoint "claude-vscode" → "claude"
    const rawSource = input.source || '';
    const source = rawSource === 'new' ? 'copilot'
        : (rawSource === 'startup' || rawSource === 'claude-vscode') ? 'claude'
        : rawSource || undefined;
    if (source && !state.mainAgentTypes.includes(source)) {
        state.mainAgentTypes.push(source);
    }
    // Persist Claude transcript path if provided at SessionStart (used at CommitMsg time)
    if (input.transcript_path && sid) {
        state.sessionTranscripts[sid] = input.transcript_path;
    }
    saveState(gitDir, state);
}

export function handleUserPromptSubmit(input: HookInput, gitDir: string): void {
    const state = loadState(gitDir);
    // Normalize source:
    //   Copilot CLI reports "new"         → "copilot"
    //   Claude Code reports "startup" or entrypoint "claude-vscode" → "claude"
    const rawSource = input.source || '';
    const source = rawSource === 'new' ? 'copilot'
        : (rawSource === 'startup' || rawSource === 'claude-vscode') ? 'claude'
        : rawSource || undefined;
    // Only count as user prompt if:
    // 1. No subagent is currently active (VS Code fires UserPromptSubmit for subagent-delegated prompts too)
    // 2. The prompt field is non-empty — VS Code also fires UserPromptSubmit for agentic
    //    tool-result continuations (model re-invocations after a tool call), which have no
    //    user-visible prompt text. Filtering on non-empty prompt avoids double-counting.
    const hasUserText = typeof input.prompt === 'string' && input.prompt.trim().length > 0;
    if (state.activeSubagents === 0 && hasUserText) {
        state.promptCount += 1;
        if (source && !state.mainAgentTypes.includes(source)) {
            state.mainAgentTypes.push(source);
        }
    }
    saveState(gitDir, state);
    // Eagerly write flag so it's present if a commit happens before Stop fires
    writeFlagEagerly(gitDir, state);
}

export function handleSubagentStart(input: HookInput, gitDir: string): void {
    const state = loadState(gitDir);
    state.activeSubagents += 1;
    state.subagentCount += 1;
    if (input.agent_type && !state.subagentTypes.includes(input.agent_type)) {
        state.subagentTypes.push(input.agent_type);
    }
    saveState(gitDir, state);
}

export function handleSubagentStop(input: HookInput, gitDir: string): void {
    const state = loadState(gitDir);
    if (state.activeSubagents > 0) {
        state.activeSubagents -= 1;
    } else {
        // SubagentStart was never received for this agent — count it here instead
        state.subagentCount += 1;
    }
    // Capture agent_type here too in case SubagentStart was missed or routed elsewhere
    if (input.agent_type) {
        if (!state.subagentTypes.includes(input.agent_type)) {
            state.subagentTypes.push(input.agent_type);
        }
    }
    saveState(gitDir, state);
    // Eagerly write flag so it's present if a commit happens before Stop fires
    writeFlagEagerly(gitDir, state);
}

export function handleStop(input: HookInput, gitDir: string): void {
    const state = loadState(gitDir);

    // Extract metadata from Copilot CLI transcript (includes full token data at shutdown)
    const sessionId = input.sessionId || input.session_id || state.sessionId;
    if (sessionId) {
        const cliData = extractFromCliTranscript(sessionId, input.transcript_path || undefined);
        for (const m of cliData.models) {
            if (!state.models.includes(m)) { state.models.push(m); }
        }
        // Merge token data from CLI transcript (session.shutdown has authoritative totals)
        if (Object.keys(cliData.tokensByModel).length > 0) {
            for (const [model, t] of Object.entries(cliData.tokensByModel)) {
                // CLI transcript is authoritative — overwrite any partial data
                state.tokensByModel[model] = t;
            }
        }
    }

    // Extract model/tokens from Claude Code transcript (per-turn, no race condition).
    // Always attempt — each reader only understands its own JSONL schema (disjoint type fields),
    // so running both readers against the same path produces no double-counting:
    //   Copilot schema: type:"session.model_change" / "assistant.message" / "session.shutdown"
    //   Claude schema:  type:"assistant" (not "assistant.message")
    if (sessionId) {
        const claudePath = input.transcript_path || state.sessionTranscripts[sessionId] || '';
        const claudeData = extractFromClaudeTranscript(sessionId, claudePath || undefined);
        for (const m of claudeData.models) {
            if (!state.models.includes(m)) { state.models.push(m); }
        }
        // Claude transcripts have per-turn totals — authoritative when present
        if (Object.keys(claudeData.tokensByModel).length > 0) {
            for (const [model, t] of Object.entries(claudeData.tokensByModel)) {
                state.tokensByModel[model] = t;
            }
        }
        // Persist path for CommitMsg time (if Stop fires before commit)
        if (claudePath && sessionId) {
            state.sessionTranscripts[sessionId] = claudePath;
        }
    }

    // Legacy: Extract metadata from transcript via generic parser
    if (input.transcript_path) {
        const meta = extractTranscriptMetadata(input.transcript_path);
        if (meta.model && !state.models.includes(meta.model)) {
            state.models.push(meta.model);
        }
        // Use producer as main agent type fallback when no agent data at all
        // e.g. "copilot-agent" → "copilot"
        if (meta.producer && state.mainAgentTypes.length === 0 && state.subagentTypes.length === 0) {
            const agentName = meta.producer.replace(/-agent$/, '');
            state.mainAgentTypes.push(agentName);
        }
    }

    // Add any models found in the VS Code Copilot Chat log file (scoped to session by session_id)
    // Use stateCreatedAt as cutoff so we only pick up models used since the state was (re)created
    const afterTs = isoToLogTimestamp(state.stateCreatedAt);
    const logModels = extractModelFromCopilotLog(undefined, sessionId, afterTs);
    for (const m of logModels.models) {
        if (!state.models.includes(m)) { state.models.push(m); }
    }
    for (const m of logModels.subagentModels) {
        if (!state.subagentModels.includes(m)) { state.subagentModels.push(m); }
    }

    // Query OTEL SQLite DB for actual token usage (requires dbSpanExporter.enabled)
    // Accumulate into tokensByModel so multi-session commits show full totals
    // Scope to spans after stateCreatedAt so previous sessions/commits don't bleed in
    if (sessionId) {
        const afterMs = new Date(state.stateCreatedAt).getTime();
        const tokensByModel = queryTokensFromOtel(sessionId, afterMs);
        if (tokensByModel) {
            for (const [model, t] of Object.entries(tokensByModel)) {
                const existing = state.tokensByModel[model];
                if (existing) {
                    existing.inputTokens     += t.inputTokens;
                    existing.outputTokens    += t.outputTokens;
                    existing.cachedTokens    += t.cachedTokens;
                    existing.reasoningTokens += t.reasoningTokens;
                } else {
                    state.tokensByModel[model] = { ...t };
                }
            }
        }
    }

    // Only write flag if there was actual activity
    if (state.promptCount > 0 || state.mainAgentTypes.length > 0 || state.subagentTypes.length > 0 || state.subagentCount > 0) {
        const flagPath = getFlagPath(gitDir);
        const newMarker = formatMarker(state);

        // Check for existing flag (from inline tracking)
        if (fs.existsSync(flagPath)) {
            const existing = fs.readFileSync(flagPath, 'utf8').trim();
            if (existing.includes('Inline')) {
                // Merge: prepend Inline to our agent info
                const agentParts: string[] = [];
                const uniqueMain = [...new Set(state.mainAgentTypes)];
                if (uniqueMain.length > 0) {
                    agentParts.push(`Agent mode: ${uniqueMain.join(', ')}`);
                }
                if (state.models && state.models.length > 0) {
                    agentParts.push(`Model: ${state.models.join(', ')}`);
                }
                if (state.promptCount > 0) {
                    agentParts.push(`Prompts: ${state.promptCount}`);
                }
                const uniqueSub = [...new Set(state.subagentTypes)];
                if (uniqueSub.length > 0) {
                    agentParts.push(`Sub-agents mode: ${uniqueSub.join(', ')}`);
                }
                const uniqueSubModels = [...new Set(state.subagentModels || [])];
                if (uniqueSubModels.length > 0) {
                    agentParts.push(`sub-Agent models: ${uniqueSubModels.join(', ')}`);
                }
                if (state.subagentCount > 0) {
                    agentParts.push(`sub-Agent prompts: ${state.subagentCount}`);
                }
                const inlineModelEntries = Object.entries(state.tokensByModel || {});
                if (inlineModelEntries.length > 0) {
                    const formatK = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
                    const modelParts = inlineModelEntries.map(([model, t]) => {
                        let s = `${model}: ${formatK(t.inputTokens)} in/${formatK(t.outputTokens)} out`;
                        if (t.cachedTokens > 0) { s += ` (${formatK(t.cachedTokens)} cached)`; }
                        if (t.reasoningTokens > 0) { s += ` +${formatK(t.reasoningTokens)} reasoning`; }
                        return s;
                    });
                    agentParts.push(`Tokens: ${modelParts.join(' | ')}`);
                }
                const combined = agentParts.length > 0
                    ? `Impacted by AI (Inline + ${agentParts.join(' | ')})`
                    : 'Impacted by AI (Inline)';
                fs.writeFileSync(flagPath, combined);
            } else {
                // Overwrite with latest agent data
                fs.writeFileSync(flagPath, newMarker);
            }
        } else {
            fs.writeFileSync(flagPath, newMarker);
        }
    }

    // Reset active subagent tracking (session is ending)
    state.activeSubagents = 0;

    // Save final state (keeps accumulating until commit-msg hook cleans up)
    saveState(gitDir, state);

    // Clean up session-to-repo mapping
    const stopSessionId = input.sessionId || input.session_id || state.sessionId || '';
    if (stopSessionId) { clearSessionRepo(stopSessionId); }
}

/**
 * Reset state after a commit has consumed it. Preserves session routing fields
 * so that late-arriving Stop events (with tokens) can still be routed correctly.
 * The next commit will only see data accumulated after this reset.
 */
function resetStateAfterCommit(gitDir: string, currentState: TrackerState): void {
    const now = new Date().toISOString();
    const resetState: TrackerState = {
        promptCount: 0,
        subagentCount: 0,
        mainAgentTypes: [],
        subagentTypes: [],
        activeSubagents: currentState.activeSubagents, // preserve for in-flight subagent tracking
        models: [],
        subagentModels: [],
        sessionId: '',                                   // cleared: consumed. Stop uses saveSessionRepo for routing.
        sessionIds: [],                                // consumed; new sessions will re-register
        sessionTranscripts: {},                        // consumed; paths no longer needed
        stateCreatedAt: now,                           // next commit only sees data after this point
        lastUpdated: now,
        tokensByModel: {},
    };
    saveState(gitDir, resetState);
}

/**
 * Called by the commit-msg shell hook before the flag is read.
 * If the session is still in progress (Stop hasn't fired yet), queries OTEL
 * for live token data and refreshes the AI_IMPACT_PENDING flag so that
 * commits made during an active session include token counts.
 */
export function handleCommitMsg(input: HookInput, gitDir: string): void {
    let state = loadState(gitDir);

    // If local state is empty, check for pending state from Copilot CLI events
    // that arrived with no git repo context (cwd was homedir/system32).
    if (state.promptCount === 0 && state.mainAgentTypes.length === 0) {
        const pendingDir = getPendingStateDir();
        const pendingStatePath = getStatePath(pendingDir);
        if (fs.existsSync(pendingStatePath)) {
            const pendingState = loadState(pendingDir);
            if (pendingState.promptCount > 0 || pendingState.mainAgentTypes.length > 0 ||
                pendingState.subagentCount > 0 || pendingState.subagentTypes.length > 0) {
                // Merge pending models into existing local state (if any)
                // then override with pending counts/types
                state = pendingState;
                if (state.models.length === 0) {
                    // Preserve any models extracted by a previous Stop event
                    const localModels = loadState(gitDir).models;
                    if (localModels.length > 0) {
                        state.models = localModels;
                    }
                }
                saveState(gitDir, state);
                writeFlagEagerly(gitDir, state);
            }
            // Clean up pending state (consumed or empty)
            try { fs.unlinkSync(pendingStatePath); } catch { /* ok */ }
            try { fs.unlinkSync(getFlagPath(pendingDir)); } catch { /* ok */ }
        }
    }

    // Legacy fallback: if still empty, check if state was misplaced in another
    // workspace (can happen with older versions of the hook handler)
    if (state.promptCount === 0 && state.mainAgentTypes.length === 0) {
        const migrated = migrateStateFromOtherWorkspaces(gitDir);
        if (migrated) {
            state = migrated;
        }
    }

    // If Stop already ran and populated token data, refresh flag and reset
    if (Object.keys(state.tokensByModel).length > 0) {
        fs.writeFileSync(getFlagPath(gitDir), formatMarker(state));
        resetStateAfterCommit(gitDir, state);
        return;
    }

    // No session ID means no session to query — refresh flag with current state and reset
    if (!state.sessionId) {
        if (state.promptCount > 0 || state.mainAgentTypes.length > 0 ||
            state.subagentCount > 0 || state.subagentTypes.length > 0) {
            fs.writeFileSync(getFlagPath(gitDir), formatMarker(state));
        }
        resetStateAfterCommit(gitDir, state);
        return;
    }

    let stateChanged = false;

    // Extract model/tokens from Copilot CLI transcripts (all sessions since last commit)
    // Each session has its own transcript at ~/.copilot/session-state/<id>/events.jsonl
    const transcriptSessionIds = state.sessionIds.length > 0 ? state.sessionIds :
        (state.sessionId ? [state.sessionId] : []);
    for (const sid of transcriptSessionIds) {
        const cliData = extractFromCliTranscript(sid);
        for (const m of cliData.models) {
            if (!state.models.includes(m)) { state.models.push(m); stateChanged = true; }
        }
        // Merge tokens (accumulate across sessions)
        for (const [model, t] of Object.entries(cliData.tokensByModel)) {
            const existing = state.tokensByModel[model];
            if (existing) {
                existing.inputTokens += t.inputTokens;
                existing.outputTokens += t.outputTokens;
                existing.cachedTokens += t.cachedTokens;
                existing.reasoningTokens += t.reasoningTokens;
            } else {
                state.tokensByModel[model] = { ...t };
            }
            stateChanged = true;
        }
    }

    // Extract model/tokens from Claude Code transcripts (per-turn, no race condition)
    // Use persisted transcript paths (set at SessionStart/Stop) or search ~/.claude/projects/
    for (const sid of transcriptSessionIds) {
        const claudePath = state.sessionTranscripts[sid] || '';
        const claudeData = extractFromClaudeTranscript(sid, claudePath || undefined);
        for (const m of claudeData.models) {
            if (!state.models.includes(m)) { state.models.push(m); stateChanged = true; }
        }
        for (const [model, t] of Object.entries(claudeData.tokensByModel)) {
            const existing = state.tokensByModel[model];
            if (existing) {
                existing.inputTokens += t.inputTokens;
                existing.outputTokens += t.outputTokens;
                existing.cachedTokens += t.cachedTokens;
                existing.reasoningTokens += t.reasoningTokens;
            } else {
                state.tokensByModel[model] = { ...t };
            }
            stateChanged = true;
        }
    }

    // Fallback: Extract models from VS Code Copilot Chat log
    if (state.models.length === 0 && state.sessionId) {
        const afterTs = isoToLogTimestamp(state.stateCreatedAt);
        const logModels = extractModelFromCopilotLog(undefined, state.sessionId, afterTs);
        for (const m of logModels.models) {
            if (!state.models.includes(m)) { state.models.push(m); stateChanged = true; }
        }
        for (const m of logModels.subagentModels) {
            if (!state.subagentModels.includes(m)) { state.subagentModels.push(m); stateChanged = true; }
        }
    }

    // Query OTEL for live token usage (session still active, Stop hasn't fired)
    const afterMs = new Date(state.stateCreatedAt).getTime();
    const tokensByModel = queryTokensFromOtel(state.sessionId, afterMs);
    if (tokensByModel) {
        state.tokensByModel = tokensByModel;
        stateChanged = true;
    }

    if (stateChanged) {
        // Persist in state for subsequent commits in the same session
        saveState(gitDir, state);
    }

    // Always ensure the flag reflects the final accumulated state.
    // Earlier eager writes (from UserPromptSubmit) may be stale if SessionStart
    // added mainAgentTypes or if model/token data was just extracted above.
    if (state.promptCount > 0 || state.mainAgentTypes.length > 0 ||
        state.subagentCount > 0 || state.subagentTypes.length > 0 ||
        Object.keys(state.tokensByModel).length > 0) {
        const flagPath = getFlagPath(gitDir);
        fs.writeFileSync(flagPath, formatMarker(state));
    }

    // Reset state — data consumed by this commit
    resetStateAfterCommit(gitDir, state);
}

// ─── Main Dispatch ───────────────────────────────────────────────────────────

export function dispatch(input: HookInput): { continue: boolean } {
    // Allow the commit-msg shell hook to supply gitDir directly (avoids cwd resolution
    // issues when the hook runs in Git's POSIX shell on Windows)
    let gitDir = input.gitDir || findGitDir(input.cwd);
    const sessionId = input.sessionId || input.session_id || '';

    // Fallback: Check session-to-repo mapping
    if (!gitDir && sessionId) {
        gitDir = lookupSessionRepo(sessionId);
    }

    // If we resolved gitDir directly from cwd or session-map, save it
    if (gitDir && sessionId) {
        saveSessionRepo(sessionId, gitDir);
    }

    // Normalize: VS Code sends snake_case, docs show camelCase — accept both
    const eventName = input.hookEventName || input.hook_event_name || '';

    // For non-CommitMsg events without a git repo: store in pending state.
    // This happens when Copilot CLI fires events from homedir/system32.
    // The pending state will be consumed at CommitMsg time when the correct
    // repo is known from the commit-msg shell hook.
    const targetDir = gitDir || getPendingStateDir();

    switch (eventName) {
        case 'SessionStart':
            handleSessionStart(input, targetDir);
            break;
        case 'UserPromptSubmit':
            handleUserPromptSubmit(input, targetDir);
            break;
        case 'SubagentStart':
            handleSubagentStart(input, targetDir);
            break;
        case 'SubagentStop':
            handleSubagentStop(input, targetDir);
            break;
        case 'Stop':
            handleStop(input, targetDir);
            break;
        case 'CommitMsg':
            if (gitDir) {
                handleCommitMsg(input, gitDir);
            }
            break;
        default:
            // Unknown event — ignore
            break;
    }

    return { continue: true };
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

function main(): void {
    let inputData = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
        inputData += chunk;
    });

    process.stdin.on('end', () => {
        try {
            const input: HookInput = JSON.parse(inputData);
            // Debug log: record full raw payload for diagnostics
            try {
                const debugLogPath = path.join(os.tmpdir(), 'ai-commit-tracker-debug.log');
                const eventName = input.hookEventName || input.hook_event_name || '?';
                // Log full raw JSON for discovery of available fields
                const logLine = `[${new Date().toISOString()}] ${eventName} ${inputData.trim()}\n`;
                fs.appendFileSync(debugLogPath, logLine);
            } catch { /* never break hook execution for logging */ }
            const result = dispatch(input);
            process.stdout.write(JSON.stringify(result));
            process.exit(0);
        } catch (error) {
            // Non-blocking: exit with code 1 (warning), don't block the agent
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`AI Commit Tracker hook error: ${message}\n`);
            process.exit(1);
        }
    });
}

// Only run main when executed directly (not imported for testing)
if (require.main === module) {
    main();
}
