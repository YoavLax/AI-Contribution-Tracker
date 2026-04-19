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
    stateCreatedAt: string;
    lastUpdated: string;
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
            if (!Array.isArray(parsed.subagentModels)) {
                parsed.subagentModels = [];
            }
            if (typeof parsed.stateCreatedAt !== 'string') {
                parsed.stateCreatedAt = parsed.lastUpdated || new Date().toISOString();
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
        stateCreatedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
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
            if (sub && !subagentModels.includes(sub[1])) { subagentModels.push(sub[1]); }
        }
        return { models, subagentModels };
    } catch {
        return { models: [], subagentModels: [] };
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

    if (parts.length > 0) {
        return `Impacted by AI (${parts.join(' | ')})`;
    }

    return 'Impacted by AI';
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
    }
    if (input.source && !state.mainAgentTypes.includes(input.source)) {
        state.mainAgentTypes.push(input.source);
    }
    saveState(gitDir, state);
}

export function handleUserPromptSubmit(input: HookInput, gitDir: string): void {
    const state = loadState(gitDir);
    // Only count as user prompt if no subagent is currently active
    // VS Code fires UserPromptSubmit for subagent-delegated prompts too
    if (state.activeSubagents > 0) {
        // This is a subagent's internal prompt, skip counting
    } else {
        state.promptCount += 1;
        if (input.source && !state.mainAgentTypes.includes(input.source)) {
            state.mainAgentTypes.push(input.source);
        }
    }
    saveState(gitDir, state);
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
    }
    saveState(gitDir, state);
}

export function handleStop(input: HookInput, gitDir: string): void {
    const state = loadState(gitDir);

    // Extract metadata from transcript (best effort)
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
    const sessionId = input.sessionId || input.session_id || state.sessionId;
    const afterTs = isoToLogTimestamp(state.stateCreatedAt);
    const logModels = extractModelFromCopilotLog(undefined, sessionId, afterTs);
    for (const m of logModels.models) {
        if (!state.models.includes(m)) { state.models.push(m); }
    }
    for (const m of logModels.subagentModels) {
        if (!state.subagentModels.includes(m)) { state.subagentModels.push(m); }
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
}

// ─── Main Dispatch ───────────────────────────────────────────────────────────

export function dispatch(input: HookInput): { continue: boolean } {
    const gitDir = findGitDir(input.cwd);
    if (!gitDir) {
        // Not a git repo — nothing to do
        return { continue: true };
    }

    // Normalize: VS Code sends snake_case, docs show camelCase — accept both
    const eventName = input.hookEventName || input.hook_event_name || '';

    switch (eventName) {
        case 'SessionStart':
            handleSessionStart(input, gitDir);
            break;
        case 'UserPromptSubmit':
            handleUserPromptSubmit(input, gitDir);
            break;
        case 'SubagentStart':
            handleSubagentStart(input, gitDir);
            break;
        case 'SubagentStop':
            handleSubagentStop(input, gitDir);
            break;
        case 'Stop':
            handleStop(input, gitDir);
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
