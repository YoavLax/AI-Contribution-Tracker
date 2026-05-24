/**
 * AI Contribution Tracker — OpenCode Plugin (v3)
 * 
 * KEY DESIGN: gitDir is resolved ONLY from file paths in tool.execute.after,
 * never from cwd. This ensures we write to the repo the agent is actually
 * working in, even when OpenCode opens a parent directory with multiple repos.
 */
import type { Plugin } from "@opencode-ai/plugin" with { "resolution-mode": "import" };
// Workaround: @opencode-ai/plugin references HeadersInit which is missing in Node types
declare global { type HeadersInit = unknown; }
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

interface TokenTotals { inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number; }
interface TrackerState {
    promptCount: number; subagentCount: number; mainAgentTypes: string[]; subagentTypes: string[];
    activeSubagents: number; models: string[]; subagentModels: string[]; sessionId: string | null;
    stateCreatedAt: string; lastUpdated: string; tokensByModel: Record<string, TokenTotals>;
}
interface SessionState {
    gitDir: string | null;
    isSubagent: boolean;
    agentName: string;
    pendingPrompts: number;      // counted before gitDir is known
    pendingModels: string[];     // collected before gitDir is known
    lastTokens: Map<string, TokenTotals>;
}

// ─── Git / State helpers ────────────────────────────────────
function findGitDir(cwd: string): string | null {
    const dotGit = path.join(cwd, ".git");
    if (fs.existsSync(dotGit)) {
        if (fs.statSync(dotGit).isDirectory()) return dotGit;
        const m = fs.readFileSync(dotGit, "utf8").trim().match(/^gitdir:\s*(.+)$/);
        if (m) { const r = path.resolve(cwd, m[1]); if (fs.existsSync(r)) return r; }
    }
    try {
        const r = path.resolve(cwd, execSync("git rev-parse --git-dir", { cwd, encoding: "utf8", stdio: ["pipe","pipe","pipe"] }).trim());
        if (fs.existsSync(r)) return r;
    } catch { /* never crash OpenCode */ }
    return null;
}
function getStatePath(g: string) { return path.join(g, "ai-tracker-state.json"); }
function getFlagPath(g: string) { return path.join(g, "AI_IMPACT_PENDING"); }
function loadState(g: string): TrackerState {
    const p = getStatePath(g);
    if (fs.existsSync(p)) { try {
        const s = JSON.parse(fs.readFileSync(p, "utf8")) as TrackerState;
        s.mainAgentTypes ??= []; s.subagentTypes ??= []; s.models ??= []; s.subagentModels ??= []; s.tokensByModel ??= {};
        if (typeof s.subagentCount !== "number") s.subagentCount = 0;
        if (typeof s.activeSubagents !== "number") s.activeSubagents = 0;
        if (typeof s.stateCreatedAt !== "string") s.stateCreatedAt = s.lastUpdated || new Date().toISOString();
        return s;
    } catch { /* never crash OpenCode */ } }
    return { promptCount: 0, subagentCount: 0, mainAgentTypes: [], subagentTypes: [], activeSubagents: 0,
        models: [], subagentModels: [], sessionId: null, stateCreatedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(), tokensByModel: {} };
}
function saveState(g: string, s: TrackerState) { s.lastUpdated = new Date().toISOString(); fs.writeFileSync(getStatePath(g), JSON.stringify(s, null, 2)); }
function formatK(n: number) { return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n); }
function formatMarker(s: TrackerState): string {
    const p: string[] = [];
    const ma = [...new Set(s.mainAgentTypes)]; if (ma.length) p.push(`Agent mode: ${ma.join(", ")}`);
    if (s.models.length) p.push(`Model: ${s.models.join(", ")}`);
    if (s.promptCount > 0) p.push(`Prompts: ${s.promptCount}`);
    const sa = [...new Set(s.subagentTypes)]; if (sa.length) p.push(`Sub-agents mode: ${sa.join(", ")}`);
    if (s.subagentCount > 0) p.push(`sub-Agent prompts: ${s.subagentCount}`);
    const te = Object.entries(s.tokensByModel);
    if (te.length) { p.push(`Tokens: ${te.map(([m, t]) => {
        let r = `${m}: ${formatK(t.inputTokens)} in/${formatK(t.outputTokens)} out`;
        if (t.cachedTokens > 0) r += ` (${formatK(t.cachedTokens)} cached)`;
        if (t.reasoningTokens > 0) r += ` +${formatK(t.reasoningTokens)} reasoning`;
        return r;
    }).join(" | ")}`); }
    return p.length ? `Impacted by AI (${p.join(" | ")})` : "Impacted by AI";
}
function writeFlag(g: string, s: TrackerState) {
    if (s.promptCount === 0 && s.mainAgentTypes.length === 0 && s.subagentTypes.length === 0 && s.subagentCount === 0 && Object.keys(s.tokensByModel).length === 0) return;
    const fp = getFlagPath(g), marker = formatMarker(s);
    if (fs.existsSync(fp)) {
        const ex = fs.readFileSync(fp, "utf8").trim();
        if (ex.includes("Inline")) {
            // Merge: preserve Inline marker, add agent data
            const inner = marker.match(/\((.+)\)$/)?.[1];
            fs.writeFileSync(fp, inner ? `Impacted by AI (Inline + ${inner})` : "Impacted by AI (Inline)");
            return;
        }
        // Always overwrite with latest state — state only grows, never shrinks
    }
    fs.writeFileSync(fp, marker);
}

// ─── Plugin ─────────────────────────────────────────────────
const sessions = new Map<string, SessionState>();

function extractSessionId(event: any): string | null {
    const p = event?.properties; if (!p) return null;
    if (typeof p.sessionID === "string" && p.sessionID) return p.sessionID;
    const i = p.info; if (!i) return null;
    return i.sessionID || i.session_id || i.id || null;
}

function getOrCreateSession(sid: string, agent?: string): SessionState {
    let sess = sessions.get(sid);
    if (sess) return sess;
    // gitDir starts null — resolved ONLY from file paths in tool.execute.after
    sess = { gitDir: null, isSubagent: false, agentName: agent ?? "session", pendingPrompts: 0, pendingModels: [], lastTokens: new Map() };
    sessions.set(sid, sess);
    return sess;
}

/** Called when gitDir is first resolved — flushes pending prompts/models to disk */
function flushPending(sess: SessionState, sid: string) {
    if (!sess.gitDir) return;
    const state = loadState(sess.gitDir);
    state.sessionId = sid;
    const src = `opencode/${sess.agentName}`;
    if (!state.mainAgentTypes.includes(src)) state.mainAgentTypes.push(src);
    state.promptCount += sess.pendingPrompts;
    for (const m of sess.pendingModels) { if (!state.models.includes(m)) state.models.push(m); }
    sess.pendingPrompts = 0;
    sess.pendingModels = [];
    saveState(sess.gitDir, state);
    // Only write flag if there is meaningful activity to report
    if (state.promptCount > 0 || state.subagentCount > 0 || Object.keys(state.tokensByModel).length > 0) {
        writeFlag(sess.gitDir, state);
    }
}

const AIContributionTracker: Plugin = async ({ directory, worktree }) => {
    const cwd = worktree || directory;
    return {
        event: async ({ event }) => {
            try {
                if (event.type === "session.created") {
                    const sid = extractSessionId(event);
                    if (!sid) return;
                    const info = (event as any).properties?.info;
                    sessions.set(sid, {
                        gitDir: null, // NEVER resolve from cwd — wait for file paths
                        isSubagent: Boolean(info?.parentID),
                        agentName: info?.agent ?? "session",
                        pendingPrompts: 0, pendingModels: [],
                        lastTokens: new Map(),
                    });
                    return;
                }
                if (event.type === "session.idle" || (event.type === "session.status" && (event as any).properties?.status?.type === "idle")) {
                    const sid = extractSessionId(event);
                    if (!sid) return;
                    const sess = sessions.get(sid);
                    if (!sess || sess.isSubagent || !sess.gitDir) return;
                    writeFlag(sess.gitDir, loadState(sess.gitDir));
                    return;
                }
                if (event.type === "session.deleted") { const sid = extractSessionId(event); if (sid) sessions.delete(sid); return; }
                if (event.type === "message.updated") {
                    const info = (event as any).properties?.info;
                    if (!info) return;
                    const sid = info.sessionID || info.session_id;
                    if (!sid) return;
                    const sess = getOrCreateSession(sid);
                    if (sess.isSubagent || !sess.gitDir) return; // skip if gitDir not yet resolved
                    if (info.role !== "assistant" || !info.finish || !info.tokens) return;
                    const modelId = info.modelID ?? "unknown";
                    const msgId = info.id || info.messageID;
                    const cur: TokenTotals = { inputTokens: Number(info.tokens.input ?? 0), outputTokens: Number(info.tokens.output ?? 0),
                        cachedTokens: Number(info.tokens.cache?.read ?? 0), reasoningTokens: Number(info.tokens.reasoning ?? 0) };
                    const prev = msgId ? sess.lastTokens.get(msgId) : undefined;
                    // Clamp deltas to >= 0 (snapshots can decrease; we never subtract)
                    const delta: TokenTotals = {
                        inputTokens:     Math.max(0, cur.inputTokens     - (prev?.inputTokens     ?? 0)),
                        outputTokens:    Math.max(0, cur.outputTokens    - (prev?.outputTokens    ?? 0)),
                        cachedTokens:    Math.max(0, cur.cachedTokens    - (prev?.cachedTokens    ?? 0)),
                        reasoningTokens: Math.max(0, cur.reasoningTokens - (prev?.reasoningTokens ?? 0)),
                    };
                    if (msgId) sess.lastTokens.set(msgId, cur);
                    // Skip if no meaningful delta across any token type
                    if (delta.inputTokens <= 0 && delta.outputTokens <= 0 && delta.cachedTokens <= 0 && delta.reasoningTokens <= 0) return;
                    const state = loadState(sess.gitDir);
                    const ex = state.tokensByModel[modelId];
                    if (ex) { ex.inputTokens += delta.inputTokens; ex.outputTokens += delta.outputTokens; ex.cachedTokens += delta.cachedTokens; ex.reasoningTokens += delta.reasoningTokens; }
                    else { state.tokensByModel[modelId] = { ...delta }; }
                    saveState(sess.gitDir, state);
                    writeFlag(sess.gitDir, state);
                }
            } catch { /* never crash OpenCode */ }
        },
        "chat.message": async (input, _output) => {
            try {
                const sess = getOrCreateSession(input.sessionID, input.agent);
                if (sess.isSubagent) return;
                if (sess.gitDir) {
                    // gitDir known — write directly
                    const state = loadState(sess.gitDir);
                    const src = `opencode/${input.agent ?? "session"}`;
                    if (!state.mainAgentTypes.includes(src)) state.mainAgentTypes.push(src);
                    state.promptCount += 1;
                    if (input.model?.modelID && !state.models.includes(input.model.modelID)) state.models.push(input.model.modelID);
                    saveState(sess.gitDir, state);
                    writeFlag(sess.gitDir, state);
                } else {
                    // gitDir NOT known yet — buffer in memory
                    sess.pendingPrompts += 1;
                    if (input.agent) sess.agentName = input.agent;
                    if (input.model?.modelID && !sess.pendingModels.includes(input.model.modelID)) sess.pendingModels.push(input.model.modelID);
                }
            } catch { /* never crash OpenCode */ }
        },
        "tool.execute.after": async (input, _output) => {
            try {
                const sess = getOrCreateSession(input.sessionID);
                if (sess.isSubagent) return;
                
                // Resolve gitDir from file path — this is the ONLY place we resolve
                if (!sess.gitDir) {
                    const args = input.args as Record<string, unknown> ?? {};
                    const fp = typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : undefined;
                    if (fp) {
                        const abs = path.isAbsolute(fp) ? fp : path.resolve(cwd, fp);
                        sess.gitDir = findGitDir(path.dirname(abs));
                        if (sess.gitDir) flushPending(sess, input.sessionID);
                    }
                }
                if (!sess.gitDir) return;

                if (input.tool === "task") {
                    const args = input.args as Record<string, unknown> ?? {};
                    // Validate agentType is a string to avoid [object Object] in markers
                    const rawType = args.subagent_type || args.category;
                    const agentType = typeof rawType === "string" ? rawType : "task";
                    const state = loadState(sess.gitDir);
                    state.subagentCount += 1;
                    if (!state.subagentTypes.includes(agentType)) state.subagentTypes.push(agentType);
                    saveState(sess.gitDir, state);
                    writeFlag(sess.gitDir, state); // keep flag current for commit-before-idle
                }
            } catch { /* never crash OpenCode */ }
        },
    };
};
export default AIContributionTracker;
export { AIContributionTracker, extractSessionId };
