/**
 * `ai-track init` / `ai-track doctor` — install (or verify/repair) every
 * integration the tracker needs, with NO dependency on VS Code:
 *   1. Global git prepare-commit-msg hook (stamps commits; invokes the binary
 *      to refresh token/OTEL/model data at commit time).
 *   2. Copilot hooks config (~/.copilot/hooks/) — VS Code Copilot + Copilot CLI.
 *   3. Claude Code hooks (~/.claude/settings.json) — only if Claude Code exists.
 *   4. OpenCode plugin registration (~/.config/opencode/opencode.json, + WSL).
 *   5. Enable the Copilot OTEL span exporter in VS Code settings so token data
 *      is captured locally (the key to not missing token metrics).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
    selfPath, toPosix, defaultGitHooksDir, vscodeUserSettingsPaths,
    ok, skip, warn, fail,
} from "./paths.ts";

const OPENCODE_PLUGIN = "@rachel_rotenberg/ai-contribution-tracker";
const HOOK_BEGIN = "# BEGIN ai-track";
const HOOK_END = "# END ai-track";
const PASSTHROUGH_SENTINEL = "# ai-track passthrough";
const COPILOT_HOOK_CONFIG = "ai-commit-tracker.json";

const GIT_COMMON_ABS = [
    '_GIT_COMMON="$(git rev-parse --git-common-dir)"',
    'case "$_GIT_COMMON" in /*) ;; *) _GIT_COMMON="$(pwd)/$_GIT_COMMON" ;; esac',
].join("\n");

function buildHookDelegation(hookName: string): string {
    return [
        GIT_COMMON_ABS,
        `LOCAL_HOOK="$_GIT_COMMON/hooks/${hookName}"`,
        'if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then',
        '    "$LOCAL_HOOK" "$@" || exit $?',
        "fi",
    ].join("\n");
}

/**
 * The managed prepare-commit-msg body. prepare-commit-msg (not commit-msg) is
 * the only commit-time hook `git commit --no-verify` cannot skip, so attribution
 * can't be silently bypassed. It invokes the binary to refresh token/OTEL data
 * (CommitMsg event) before reading the AI_IMPACT_PENDING flag.
 */
function buildManagedHookBody(binaryPathPosix: string): string {
    return [
        HOOK_BEGIN,
        'case "$2" in merge|squash|commit) exit 0 ;; esac',
        `AI_TRACK="${binaryPathPosix}"`,
        'IMPACT_FLAG=$(git rev-parse --git-path AI_IMPACT_PENDING)',
        'STATE_FILE=$(git rev-parse --git-path ai-tracker-state.json)',
        '# Refresh token/OTEL/model data for the current session before stamping.',
        'if [ -x "$AI_TRACK" ] || [ -f "$AI_TRACK" ]; then',
        '    GIT_ABS_DIR=$(git rev-parse --absolute-git-dir)',
        `    printf '{"hookEventName":"CommitMsg","cwd":".","gitDir":"%s"}' "$GIT_ABS_DIR" | "$AI_TRACK" hook >/dev/null 2>&1 || true`,
        "fi",
        'if [ -f "$IMPACT_FLAG" ]; then',
        '    MARKER=$(cat "$IMPACT_FLAG")',
        '    if [ -z "$MARKER" ]; then MARKER="Impacted by AI"; fi',
        '    FIRST_LINE=$(head -n 1 "$IMPACT_FLAG")',
        '    if ! grep -qF "$FIRST_LINE" "$1"; then',
        '        if [ -s "$1" ] && [ "$(tail -c 1 "$1" | wc -l)" -eq 0 ]; then printf "\\n" >> "$1"; fi',
        '        echo "" >> "$1"',
        '        echo "$MARKER" >> "$1"',
        "    fi",
        '    rm "$IMPACT_FLAG"',
        "fi",
        'if [ -f "$STATE_FILE" ]; then rm "$STATE_FILE"; fi',
        HOOK_END,
    ].join("\n");
}

// ─── Git hook ───────────────────────────────────────────────

function appendOrCreateHook(hooksDir: string, binaryPathPosix: string): void {
    const hookPath = path.join(hooksDir, "prepare-commit-msg");
    const delegation = buildHookDelegation("prepare-commit-msg");
    const body = buildManagedHookBody(binaryPathPosix);

    if (fs.existsSync(hookPath)) {
        let existing = fs.readFileSync(hookPath, "utf8").replace(/\r\n/g, "\n");
        if (existing.includes(HOOK_BEGIN)) {
            // Replace the managed block in place (keeps the binary path current).
            existing = replaceManagedBlock(existing, body);
            fs.writeFileSync(hookPath, existing);
            ok(`Updated prepare-commit-msg hook: ${hookPath}`);
        } else {
            fs.appendFileSync(hookPath, "\n" + body + "\n");
            ok(`Appended AI tracker block to existing hook: ${hookPath}`);
        }
    } else {
        const content = ("#!/bin/sh\n" + delegation + "\n\n" + body + "\n").replace(/\r\n/g, "\n");
        fs.writeFileSync(hookPath, content);
        ok(`Created prepare-commit-msg hook: ${hookPath}`);
    }
    try { fs.chmodSync(hookPath, "755"); } catch { /* Windows */ }
}

function replaceManagedBlock(content: string, newBody: string): string {
    const lines = content.split("\n");
    const out: string[] = [];
    let skipping = false;
    let replaced = false;
    for (const line of lines) {
        if (line.includes(HOOK_BEGIN)) {
            skipping = true;
            if (!replaced) { out.push(...newBody.split("\n")); replaced = true; }
            continue;
        }
        if (line.includes(HOOK_END)) { skipping = false; continue; }
        if (!skipping) { out.push(line); }
    }
    return out.join("\n");
}

const PASSTHROUGH_HOOKS = [
    "pre-commit", "pre-push", "commit-msg",
    "post-commit", "post-merge", "pre-rebase",
];

function ensurePassthroughHooks(hooksDir: string): void {
    for (const hookName of PASSTHROUGH_HOOKS) {
        const hookPath = path.join(hooksDir, hookName);
        if (fs.existsSync(hookPath)) { continue; }
        const content = [
            "#!/bin/sh",
            PASSTHROUGH_SENTINEL,
            GIT_COMMON_ABS,
            `LOCAL_HOOK="$_GIT_COMMON/hooks/${hookName}"`,
            'if [ -f "$LOCAL_HOOK" ] && [ -x "$LOCAL_HOOK" ]; then',
            '    "$LOCAL_HOOK" "$@" || exit $?',
            "fi",
            "",
        ].join("\n");
        fs.writeFileSync(hookPath, content);
        try { fs.chmodSync(hookPath, "755"); } catch { /* Windows */ }
    }
}

function installGitHook(binaryPathPosix: string): void {
    console.log("\nGit prepare-commit-msg hook:");
    let existingPath = "";
    try {
        existingPath = execFileSync("git", ["config", "--global", "core.hooksPath"], {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch { /* not set */ }

    const hooksDir = existingPath || defaultGitHooksDir();
    fs.mkdirSync(hooksDir, { recursive: true });
    appendOrCreateHook(hooksDir, binaryPathPosix);
    ensurePassthroughHooks(hooksDir);

    if (!existingPath) {
        try {
            execFileSync("git", ["config", "--global", "core.hooksPath", toPosix(hooksDir)], {
                encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
            });
            ok(`Set git global core.hooksPath: ${toPosix(hooksDir)}`);
        } catch (e) {
            fail(`Could not set core.hooksPath: ${(e as Error).message}`);
        }
    }
}

// ─── Copilot hooks (VS Code Copilot + Copilot CLI) ──────────

function installCopilotHooks(binaryPathPosix: string, binaryPathNative: string): void {
    console.log("\nCopilot hooks (VS Code + CLI):");
    const copilotHooksDir = path.join(os.homedir(), ".copilot", "hooks");
    fs.mkdirSync(copilotHooksDir, { recursive: true });

    const command = `"${binaryPathPosix}" hook`;
    const windows = `"${binaryPathNative}" hook`;
    const entry = (timeout: number) => [{ type: "command", command, windows, timeout }];

    const hookConfig = {
        version: 1,
        hooks: {
            SessionStart: entry(10),
            UserPromptSubmit: entry(10),
            SubagentStart: entry(10),
            SubagentStop: entry(10),
            Stop: entry(15),
        },
    };

    const configPath = path.join(copilotHooksDir, COPILOT_HOOK_CONFIG);
    fs.writeFileSync(configPath, JSON.stringify(hookConfig, null, 2));
    ok(`Copilot hooks config written: ${configPath}`);
}

// ─── Claude Code hooks ──────────────────────────────────────

function installClaudeHooks(binaryPathPosix: string): void {
    console.log("\nClaude Code hooks:");
    const claudeDir = path.join(os.homedir(), ".claude");
    if (!fs.existsSync(claudeDir)) {
        skip("~/.claude/ not found — Claude Code not installed");
        return;
    }
    const settingsPath = path.join(claudeDir, "settings.json");
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
        try {
            settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
        } catch {
            fs.copyFileSync(settingsPath, settingsPath + ".bak");
            warn(`Backed up malformed settings.json to ${settingsPath}.bak`);
            settings = {};
        }
    }

    const command = `"${binaryPathPosix}" hook`;
    const trackedEvents = ["SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"];
    let hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};
    if (typeof hooks !== "object" || hooks === null) { hooks = {}; }
    let modified = false;

    for (const eventName of trackedEvents) {
        const timeout = eventName === "Stop" ? 15 : 10;
        const eventHooks = hooks[eventName] as Array<{ hooks?: Array<{ command?: string;[k: string]: unknown }> }> | undefined;
        if (!Array.isArray(eventHooks)) {
            hooks[eventName] = [{ hooks: [{ type: "command", command, timeout }] }];
            modified = true;
            continue;
        }
        let found = false;
        for (const group of eventHooks) {
            if (!Array.isArray(group.hooks)) { continue; }
            for (let i = 0; i < group.hooks.length; i++) {
                const h = group.hooks[i];
                if (h.command && (h.command.includes("ai-track") || h.command.includes("hook-handler.js"))) {
                    if (h.command !== command) { group.hooks[i] = { ...h, command }; modified = true; }
                    found = true;
                    break;
                }
            }
            if (found) { break; }
        }
        if (!found) {
            eventHooks.push({ hooks: [{ type: "command", command, timeout }] });
            modified = true;
        }
    }

    if (modified) {
        const backupPath = settingsPath + ".bak";
        if (fs.existsSync(settingsPath) && !fs.existsSync(backupPath)) {
            fs.copyFileSync(settingsPath, backupPath);
        }
        settings.hooks = hooks;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        ok(`Claude Code hooks written: ${settingsPath}`);
    } else {
        skip("Claude Code hooks already configured");
    }
}

// ─── OpenCode plugin ────────────────────────────────────────

function addOpenCodePlugin(configDir: string): void {
    try {
        fs.mkdirSync(configDir, { recursive: true });
        const configPath = path.join(configDir, "opencode.json");
        let config: Record<string, unknown> = {};
        if (fs.existsSync(configPath)) {
            try {
                config = JSON.parse(fs.readFileSync(configPath, "utf8"));
            } catch {
                fs.copyFileSync(configPath, configPath + ".bak");
                config = {};
            }
        }
        let plugins = config.plugin as Array<string | [string, Record<string, unknown>]> | undefined;
        if (!Array.isArray(plugins)) { plugins = []; }
        const already = plugins.some((p) => (typeof p === "string" ? p : Array.isArray(p) ? p[0] : null) === OPENCODE_PLUGIN);
        if (already) {
            skip(`Plugin already registered: ${configPath}`);
            return;
        }
        plugins.push(OPENCODE_PLUGIN);
        config.plugin = plugins;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        ok(`Added OpenCode plugin: ${configPath}`);
    } catch (e) {
        fail(`Could not update ${configDir}: ${(e as Error).message}`);
    }
}

function installOpenCode(): void {
    console.log("\nOpenCode plugin:");
    addOpenCodePlugin(path.join(os.homedir(), ".config", "opencode"));

    if (process.platform === "win32") {
        try {
            const wslHome = execFileSync("wsl", ["-e", "sh", "-c", "echo $HOME"], { encoding: "utf8", timeout: 5000 }).trim();
            if (wslHome) {
                const wslConfigDir = execFileSync("wsl", ["-e", "wslpath", "-w", `${wslHome}/.config/opencode`], { encoding: "utf8", timeout: 5000 }).trim();
                if (wslConfigDir) { addOpenCodePlugin(wslConfigDir); }
            }
        } catch {
            skip("WSL not available — skipping WSL OpenCode config");
        }
    }
}

// ─── OTEL enablement (token capture) ────────────────────────

/**
 * Enable the Copilot OTEL DB span exporter and AI co-author trailer directly in
 * VS Code User settings.json. This is what makes real token counts land in the
 * local agent-traces.db — without it, markers would omit token data.
 */
function enableOtelSettings(): void {
    console.log("\nToken tracking (VS Code OTEL settings):");
    let touched = false;
    for (const settingsPath of vscodeUserSettingsPaths()) {
        if (!fs.existsSync(path.dirname(settingsPath))) { continue; }
        let settings: Record<string, unknown> = {};
        if (fs.existsSync(settingsPath)) {
            try {
                settings = JSON.parse(stripJsonComments(fs.readFileSync(settingsPath, "utf8"))) as Record<string, unknown>;
            } catch {
                warn(`Could not parse ${settingsPath} — skipping`);
                continue;
            }
        }
        let changed = false;
        if (settings["github.copilot.chat.otel.dbSpanExporter.enabled"] !== true) {
            settings["github.copilot.chat.otel.dbSpanExporter.enabled"] = true;
            changed = true;
        }
        if (settings["git.addAICoAuthor"] !== "all") {
            settings["git.addAICoAuthor"] = "all";
            changed = true;
        }
        if (changed) {
            fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            ok(`Enabled token tracking in: ${settingsPath}`);
            touched = true;
        }
    }
    if (touched) {
        warn("Reload VS Code for OTEL token tracking to take effect.");
    } else {
        skip("No VS Code settings.json required changes (or VS Code not installed)");
    }
}

/** Minimal JSON-with-comments stripper for VS Code settings.json. */
function stripJsonComments(text: string): string {
    return text
        .replace(/\\"|"(?:\\"|[^"])*"|(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)/g, (m, g) => (g ? "" : m));
}

// ─── Entry point ────────────────────────────────────────────

export function runInit(opts: { doctor?: boolean } = {}): void {
    const label = opts.doctor ? "Verifying / repairing" : "Installing";
    console.log(`\nAI Contribution Tracker (ai-track) \u2014 ${label}...\n`);
    console.log(`Platform: ${process.platform} (${os.arch()})`);

    const binaryNative = selfPath();
    const binaryPosix = toPosix(binaryNative);

    installGitHook(binaryPosix);
    installCopilotHooks(binaryPosix, binaryNative);
    installClaudeHooks(binaryPosix);
    installOpenCode();
    enableOtelSettings();

    console.log("\nDone. All future AI-assisted commits will be tagged automatically.\n");
}
