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
import * as os from "os";

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
function getConsumedPath(g: string) { return path.join(g, "AI_IMPACT_CONSUMED"); }
// Consumed state is per-repo (gitDir), not per-session — different event types
// may use different session IDs but write to the same repo.
const consumedRepos = new Set<string>();
function isConsumed(gitDir: string | null): boolean {
    if (!gitDir) return false;
    if (consumedRepos.has(gitDir)) return true;
    if (fs.existsSync(getConsumedPath(gitDir))) {
        consumedRepos.add(gitDir);
        try { fs.unlinkSync(getStatePath(gitDir)); } catch { /* ok */ }
        try { fs.unlinkSync(getFlagPath(gitDir)); } catch { /* ok */ }
        return true;
    }
    return false;
}
function unconsume(gitDir: string | null) {
    if (!gitDir) return;
    consumedRepos.delete(gitDir);
    try { fs.unlinkSync(getConsumedPath(gitDir)); } catch { /* ok */ }
}
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
function buildCoAuthoredBy(s: TrackerState): string {
    const models = s.models.join(", ");
    const coAuthorName = models || s.promptCount > 0
        ? `OpenCode (${[models, s.promptCount > 0 ? `${s.promptCount}p` : ""].filter(Boolean).join(", ")})`
        : "OpenCode";
    return `Co-authored-by: ${coAuthorName} <noreply@opencode.dev>`;
}
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
    const marker = p.length ? `Impacted by AI (${p.join(" | ")})` : "Impacted by AI";
    return `${marker}\n${buildCoAuthoredBy(s)}`;
}
function writeFlag(g: string, s: TrackerState) {
    if (s.promptCount === 0 && s.mainAgentTypes.length === 0 && s.subagentTypes.length === 0 && s.subagentCount === 0 && Object.keys(s.tokensByModel).length === 0) return;
    const fp = getFlagPath(g), marker = formatMarker(s);
    if (fs.existsSync(fp)) {
        const ex = fs.readFileSync(fp, "utf8").trim();
        if (ex.includes("Inline")) {
            // Merge: preserve Inline marker, add agent data
            const inner = marker.split('\n')[0].match(/\((.+)\)$/)?.[1];
            const coAuthorLine = marker.split('\n').slice(1).join('\n');
            const merged = inner ? `Impacted by AI (Inline + ${inner})` : "Impacted by AI (Inline)";
            fs.writeFileSync(fp, coAuthorLine ? `${merged}\n${coAuthorLine}` : merged);
            return;
        }
        // Always overwrite with latest state — state only grows, never shrinks
    }
    fs.writeFileSync(fp, marker);
}

// ─── Plugin ─────────────────────────────────────────────────

// ─── Auto Git Hook Installation ─────────────────────────────
// Stamps via prepare-commit-msg, NOT commit-msg: prepare-commit-msg is the only
// commit-time hook `git commit --no-verify` cannot skip, so AI attribution can't
// be silently bypassed. $2 is the commit source (merge/squash/message/template);
// skip those so we never disturb generated merge/squash messages.
const PLUGIN_SENTINEL = "# AI Contribution Tracker (opencode-plugin) — stamp AI_IMPACT_PENDING";
const prepareCommitMsgBody = [
    "",
    PLUGIN_SENTINEL,
    'case "$2" in merge|squash|commit) exit 0 ;; esac',
    'IMPACT_FLAG=$(git rev-parse --git-path AI_IMPACT_PENDING)',
    'STATE_FILE=$(git rev-parse --git-path ai-tracker-state.json)',
    'if [ -f "$IMPACT_FLAG" ]; then',
    '    MARKER=$(cat "$IMPACT_FLAG")',
    '    if [ -z "$MARKER" ]; then MARKER="Impacted by AI"; fi',
    '    if ! grep -qF "$MARKER" "$1"; then',
    '        echo "" >> "$1"',
    '        echo "$MARKER" >> "$1"',
    '    fi',
    '    rm "$IMPACT_FLAG"',
    'fi',
    'if [ -f "$STATE_FILE" ]; then rm "$STATE_FILE"; fi',
].join("\n");

const POST_COMMIT_SENTINEL = "# AI Contribution Tracker (opencode-plugin) — signal commit consumed AI state";
const postCommitBody = [
    "",
    POST_COMMIT_SENTINEL,
    'touch "$(git rev-parse --git-path AI_IMPACT_CONSUMED 2>/dev/null)" 2>/dev/null || true',
    'rm -f "$(git rev-parse --git-path AI_IMPACT_PENDING 2>/dev/null)" 2>/dev/null',
    'rm -f "$(git rev-parse --git-path ai-tracker-state.json 2>/dev/null)" 2>/dev/null',
].join("\n");

function appendOrCreateHook(hooksDir: string, hookName: string, hookBody: string) {
    const hookPath = path.join(hooksDir, hookName);
    if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, "utf8");
        // Dedup on a plugin-unique sentinel, NOT the shared "AI_IMPACT_PENDING"
        // string. The VS Code extension's hook also contains that string, so the
        // old check made the plugin think its hook was already installed and skip
        // it — deferring to the extension. Keying on our own sentinel lets both
        // tools' hooks coexist in a shared core.hooksPath dir.
        const sentinel = hookName === "post-commit" ? POST_COMMIT_SENTINEL : PLUGIN_SENTINEL;
        if (existing.includes(sentinel)) return;
        fs.appendFileSync(hookPath, "\n" + hookBody + "\n");
    } else {
        fs.writeFileSync(hookPath, "#!/bin/sh\n" + hookBody + "\n");
    }
    try { fs.chmodSync(hookPath, "755"); } catch { /* Windows */ }
}

// Older versions installed the stamp into commit-msg (bypassable by --no-verify).
// On upgrade, drop our own commit-msg hook so we don't double-run alongside the
// new prepare-commit-msg one. Only removes a file we recognize as solely ours.
const OLD_COMMIT_MSG_SENTINEL = "# AI Contribution Tracker — reads AI_IMPACT_PENDING flag";
function removeStalePluginCommitMsg(hooksDir: string) {
    const hookPath = path.join(hooksDir, "commit-msg");
    if (!fs.existsSync(hookPath)) return;
    const existing = fs.readFileSync(hookPath, "utf8");
    if (!existing.includes(OLD_COMMIT_MSG_SENTINEL)) return;
    const stripped = existing.replace(new RegExp(`\\n*${OLD_COMMIT_MSG_SENTINEL}[\\s\\S]*$`), "\n");
    if (stripped.trim() === "#!/bin/sh") {
        try { fs.unlinkSync(hookPath); } catch { /* ok */ }
    } else {
        fs.writeFileSync(hookPath, stripped);
    }
}

function ensureGitHook() {
    try {
        const existingPath = execSync("git config --global core.hooksPath", {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        // Ensure the configured hooks dir exists (it may have been deleted)
        fs.mkdirSync(existingPath, { recursive: true });
        removeStalePluginCommitMsg(existingPath);
        appendOrCreateHook(existingPath, "prepare-commit-msg", prepareCommitMsgBody);
        appendOrCreateHook(existingPath, "post-commit", postCommitBody);
    } catch {
        const hooksDir = path.join(os.homedir(), ".config", "ai-contribution-tracker", "git-hooks");
        fs.mkdirSync(hooksDir, { recursive: true });
        removeStalePluginCommitMsg(hooksDir);
        appendOrCreateHook(hooksDir, "prepare-commit-msg", prepareCommitMsgBody);
        appendOrCreateHook(hooksDir, "post-commit", postCommitBody);
        try {
            execSync(`git config --global core.hooksPath "${hooksDir}"`, {
                encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
            });
        } catch { /* git not available */ }
    }
}
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

/** Flush buffered prompts/models to disk. Caller must unconsume() first if needed. */
function flushPending(sess: SessionState, sid: string) {
    if (!sess.gitDir || (sess.pendingPrompts === 0 && sess.pendingModels.length === 0)) return;
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
    try { ensureGitHook(); } catch { /* never block plugin init */ }
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
                    if (isConsumed(sess.gitDir)) return;
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
                    if (sess.isSubagent || !sess.gitDir) return;
                    if (isConsumed(sess.gitDir)) return;
                    if (info.role !== "assistant" || !info.finish || !info.tokens) return;
                    const modelId = info.modelID ?? "unknown";
                    const msgId = info.id || info.messageID;
                    const rawInput = Number(info.tokens.input ?? 0);
                    const cacheRead = Number(info.tokens.cache?.read ?? 0);
                    // OpenCode normalises tokens.input to fresh-only (cache subtracted) for
                    // every provider (Anthropic, OpenAI, Gemini).  Total input = fresh + cached.
                    const totalInput = rawInput + cacheRead;
                    const cur: TokenTotals = { inputTokens: totalInput, outputTokens: Number(info.tokens.output ?? 0),
                        cachedTokens: cacheRead, reasoningTokens: Number(info.tokens.reasoning ?? 0) };
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
                isConsumed(sess.gitDir);
                if (isConsumed(sess.gitDir)) {
                    // Consumed: buffer prompt but don't write to disk.
                    // Only un-consume when AI touches files (tool.execute.after).
                    sess.pendingPrompts += 1;
                    if (input.agent) sess.agentName = input.agent;
                    if (input.model?.modelID && !sess.pendingModels.includes(input.model.modelID)) sess.pendingModels.push(input.model.modelID);
                    return;
                }
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

                // Resolve gitDir for ALL sessions (main + subagents) so
                // AI_IMPACT_PENDING flag exists when any agent commits
                if (!sess.gitDir || !fs.existsSync(sess.gitDir)) {
                    const args = input.args as Record<string, unknown> ?? {};
                    const fp = typeof args.filePath === "string" ? args.filePath : typeof args.path === "string" ? args.path : typeof args.workdir === "string" ? args.workdir : undefined;
                    if (fp) {
                        const abs = path.isAbsolute(fp) ? fp : path.resolve(cwd, fp);
                        const searchDir = fp === args.workdir ? abs : path.dirname(abs);
                        sess.gitDir = findGitDir(searchDir);
                        if (sess.gitDir) {
                            if (!sess.isSubagent) {
                                unconsume(sess.gitDir);
                                flushPending(sess, input.sessionID);
                            } else {
                                // Subagent: ensure flag exists for commit-msg hook
                                const state = loadState(sess.gitDir);
                                const hasActivity = state.promptCount > 0 || state.mainAgentTypes.length > 0
                                    || state.subagentTypes.length > 0 || state.subagentCount > 0
                                    || Object.keys(state.tokensByModel).length > 0;
                                if (hasActivity) { writeFlag(sess.gitDir, state); }
                                else if (!fs.existsSync(getFlagPath(sess.gitDir))) {
                                    fs.writeFileSync(getFlagPath(sess.gitDir), `Impacted by AI\n${buildCoAuthoredBy(state)}`);
                                }
                            }
                        }
                    }
                }
                if (!sess.gitDir) return;
                const toolArgs = input.args as Record<string, unknown> ?? {};
                const hasFilePath = typeof toolArgs.filePath === "string" || typeof toolArgs.path === "string" || typeof toolArgs.workdir === "string";
                if (isConsumed(sess.gitDir) && hasFilePath) { unconsume(sess.gitDir); if (!sess.isSubagent) flushPending(sess, input.sessionID); }
                if (isConsumed(sess.gitDir) || sess.isSubagent) return;

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
// Named exports omitted — OpenCode calls all exported functions as plugins
