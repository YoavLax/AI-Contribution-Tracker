/**
 * `ai-track remove` — cleanly uninstall every integration.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { defaultGitHooksDir, toPosix, ok, skip } from "./paths.ts";

const HOOK_BEGIN = "# BEGIN ai-track";
const HOOK_END = "# END ai-track";
const PASSTHROUGH_SENTINEL = "# ai-track passthrough";
const OPENCODE_PLUGIN = "@rachel_rotenberg/ai-contribution-tracker";
const PASSTHROUGH_HOOKS = [
    "pre-commit", "pre-push", "commit-msg",
    "post-commit", "post-merge", "pre-rebase",
];

function removeManagedBlock(hookFile: string): boolean {
    if (!fs.existsSync(hookFile)) { return false; }
    const content = fs.readFileSync(hookFile, "utf8");
    if (!content.includes(HOOK_BEGIN)) { return false; }
    const lines = content.split("\n");
    const kept: string[] = [];
    let skipping = false;
    for (const line of lines) {
        if (line.includes(HOOK_BEGIN)) { skipping = true; continue; }
        if (line.includes(HOOK_END)) { skipping = false; continue; }
        if (!skipping) { kept.push(line); }
    }
    const remaining = kept.join("\n").trim();
    if (remaining === "#!/bin/sh" || remaining === "") {
        fs.unlinkSync(hookFile);
    } else {
        fs.writeFileSync(hookFile, remaining + "\n");
    }
    return true;
}

function removeGitHook(): void {
    console.log("\nGit hook:");
    let hooksPath = "";
    try {
        hooksPath = execFileSync("git", ["config", "--global", "core.hooksPath"], {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch { /* not set */ }

    if (!hooksPath) { skip("No global core.hooksPath set"); return; }

    const removed = removeManagedBlock(path.join(hooksPath, "prepare-commit-msg"));
    if (removed) { ok(`Removed ai-track block from prepare-commit-msg`); }
    else { skip("No ai-track block in prepare-commit-msg"); }

    for (const hookName of PASSTHROUGH_HOOKS) {
        const p = path.join(hooksPath, hookName);
        if (fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(PASSTHROUGH_SENTINEL)) {
            fs.unlinkSync(p);
            ok(`Removed passthrough hook: ${hookName}`);
        }
    }

    // Unset core.hooksPath only if it points at OUR default directory.
    if (toPosix(hooksPath) === toPosix(defaultGitHooksDir())) {
        try {
            execFileSync("git", ["config", "--global", "--unset", "core.hooksPath"], {
                encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
            });
            ok("Unset git global core.hooksPath");
        } catch { /* ignore */ }
    }
}

function removeCopilotHooks(): void {
    console.log("\nCopilot hooks:");
    const configPath = path.join(os.homedir(), ".copilot", "hooks", "ai-commit-tracker.json");
    if (fs.existsSync(configPath)) {
        fs.unlinkSync(configPath);
        ok(`Removed: ${configPath}`);
    } else {
        skip("No Copilot hooks config found");
    }
}

function removeClaudeHooks(): void {
    console.log("\nClaude Code hooks:");
    const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
    if (!fs.existsSync(settingsPath)) { skip("No Claude Code settings found"); return; }
    let settings: Record<string, unknown>;
    try {
        settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch { skip("Could not parse Claude settings"); return; }

    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks || typeof hooks !== "object") { skip("No hooks in Claude settings"); return; }

    let removed = false;
    const events = ["SessionStart", "UserPromptSubmit", "SubagentStart", "SubagentStop", "Stop"];
    for (const eventName of events) {
        const eventHooks = hooks[eventName] as Array<{ hooks?: Array<{ command?: string }> }> | undefined;
        if (!Array.isArray(eventHooks)) { continue; }
        const filtered = eventHooks.filter((group) => {
            if (!Array.isArray(group.hooks)) { return true; }
            const remaining = group.hooks.filter(
                (h) => !h.command || !(h.command.includes("ai-track") || h.command.includes("hook-handler.js")),
            );
            if (remaining.length === 0) { removed = true; return false; }
            if (remaining.length < group.hooks.length) { group.hooks = remaining; removed = true; }
            return true;
        });
        if (filtered.length === 0) { delete hooks[eventName]; }
        else { hooks[eventName] = filtered; }
    }

    if (removed) {
        if (Object.keys(hooks).length === 0) { delete settings.hooks; }
        else { settings.hooks = hooks; }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        ok("Removed ai-track hooks from Claude settings");
    } else {
        skip("No ai-track hooks in Claude settings");
    }
}

function removeOpenCode(): void {
    console.log("\nOpenCode plugin:");
    const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (!fs.existsSync(configPath)) { skip("No opencode.json found"); return; }
    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (!Array.isArray(config.plugin)) { skip("No plugin array"); return; }
        const before = config.plugin.length;
        config.plugin = config.plugin.filter(
            (p: unknown) => (typeof p === "string" ? p : Array.isArray(p) ? p[0] : null) !== OPENCODE_PLUGIN,
        );
        if (config.plugin.length === before) { skip("Plugin was not registered"); return; }
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        ok(`Removed plugin from: ${configPath}`);
    } catch { skip("Could not parse opencode.json"); }
}

export function runRemove(): void {
    console.log("\nAI Contribution Tracker (ai-track) \u2014 Removing...");
    removeGitHook();
    removeCopilotHooks();
    removeClaudeHooks();
    removeOpenCode();
    console.log("\nDone. (VS Code OTEL settings left untouched — remove them manually if desired.)\n");
}
