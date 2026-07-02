/**
 * `ai-track status` — report what is installed and healthy.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { resolveOtelDbPath } from "../../../src/hook-handler.ts";
import { vscodeUserSettingsPaths, ok, skip, warn } from "./paths.ts";

const HOOK_BEGIN = "# BEGIN ai-track";
const OPENCODE_PLUGIN = "@rachel_rotenberg/ai-contribution-tracker";

export function runStatus(): void {
    console.log("\nAI Contribution Tracker \u2014 Status\n");

    // Git hook
    let hooksPath = "";
    try {
        hooksPath = execFileSync("git", ["config", "--global", "core.hooksPath"], {
            encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch { /* not set */ }

    if (hooksPath) {
        const hookFile = path.join(hooksPath, "prepare-commit-msg");
        if (fs.existsSync(hookFile) && fs.readFileSync(hookFile, "utf8").includes(HOOK_BEGIN)) {
            ok(`Git hook installed: ${hookFile}`);
        } else {
            warn(`core.hooksPath set to ${hooksPath} but no ai-track block found`);
        }
    } else {
        warn("No global core.hooksPath set \u2014 git hook not installed");
    }

    // Copilot hooks
    const copilotConfig = path.join(os.homedir(), ".copilot", "hooks", "ai-commit-tracker.json");
    if (fs.existsSync(copilotConfig)) {
        ok(`Copilot hooks config: ${copilotConfig}`);
    } else {
        warn("Copilot hooks config not found");
    }

    // Claude Code hooks
    const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
    if (fs.existsSync(claudeSettings)) {
        try {
            const raw = fs.readFileSync(claudeSettings, "utf8");
            if (raw.includes("ai-track") || raw.includes("hook-handler.js")) {
                ok(`Claude Code hooks registered: ${claudeSettings}`);
            } else {
                skip("Claude Code installed but tracker hooks not registered");
            }
        } catch { warn(`Could not parse ${claudeSettings}`); }
    } else {
        skip("Claude Code not installed");
    }

    // OpenCode plugin
    const opencodeConfig = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (fs.existsSync(opencodeConfig)) {
        try {
            const config = JSON.parse(fs.readFileSync(opencodeConfig, "utf8"));
            const plugins = Array.isArray(config.plugin) ? config.plugin : [];
            const found = plugins.some(
                (p: unknown) => (typeof p === "string" ? p : Array.isArray(p) ? p[0] : null) === OPENCODE_PLUGIN,
            );
            if (found) { ok(`OpenCode plugin registered: ${opencodeConfig}`); }
            else { warn(`opencode.json exists but plugin not registered`); }
        } catch { warn(`Could not parse ${opencodeConfig}`); }
    } else {
        skip("No opencode.json found");
    }

    // OTEL token tracking
    const otelDb = resolveOtelDbPath();
    if (otelDb) {
        ok(`OTEL token DB found: ${otelDb}`);
    } else {
        warn("OTEL token DB not found (open VS Code Copilot Chat once to create it)");
    }
    let otelEnabled = false;
    for (const settingsPath of vscodeUserSettingsPaths()) {
        if (!fs.existsSync(settingsPath)) { continue; }
        try {
            const raw = fs.readFileSync(settingsPath, "utf8");
            if (/"github\.copilot\.chat\.otel\.dbSpanExporter\.enabled"\s*:\s*true/.test(raw)) {
                otelEnabled = true;
            }
        } catch { /* ignore */ }
    }
    if (otelEnabled) { ok("OTEL span exporter enabled in VS Code settings"); }
    else { warn("OTEL span exporter not enabled — run `ai-track init`"); }

    console.log("");
}
