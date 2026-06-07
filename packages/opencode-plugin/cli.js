#!/usr/bin/env node
/**
 * AI Contribution Tracker — Standalone CLI Installer
 *
 * Installs the git commit-msg hook and registers the OpenCode plugin
 * without requiring VS Code. Works on macOS, Linux, and Windows.
 *
 * Usage:
 *   npx @rachel_rotenberg/ai-contribution-tracker init     # Install everything
 *   npx @rachel_rotenberg/ai-contribution-tracker status   # Show what's installed
 *   npx @rachel_rotenberg/ai-contribution-tracker remove   # Uninstall hooks + plugin
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, execFileSync } = require("child_process");

// ─── Constants ──────────────────────────────────────────────
const PLUGIN_NAME = "@rachel_rotenberg/ai-contribution-tracker";
const HOOK_MARKER = "AI_IMPACT_PENDING";

// ─── Logging helpers ────────────────────────────────────────
function ok(msg)   { console.log(`  \u2713 ${msg}`); }
function skip(msg) { console.log(`  - ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }
function fail(msg) { console.error(`  \u2717 ${msg}`); }

// ─── Git hook body (shell script, runs on all platforms via Git Bash) ───
const HOOK_BODY = [
    "",
    "# AI Contribution Tracker \u2014 reads AI_IMPACT_PENDING flag",
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

// ─── Git hook installation ──────────────────────────────────

/** Append our hook snippet to an existing commit-msg hook or create a new one. */
function appendOrCreateHook(hooksDir) {
    const hookPath = path.join(hooksDir, "commit-msg");

    if (fs.existsSync(hookPath)) {
        const existing = fs.readFileSync(hookPath, "utf8");
        if (existing.includes(HOOK_MARKER)) {
            skip(`commit-msg hook already has AI tracker snippet: ${hookPath}`);
            return;
        }
        fs.appendFileSync(hookPath, "\n" + HOOK_BODY + "\n");
        ok(`Appended AI tracker snippet to existing hook: ${hookPath}`);
    } else {
        const content = ("#!/bin/sh\n" + HOOK_BODY + "\n").replace(/\r\n/g, "\n");
        fs.writeFileSync(hookPath, content);
        ok(`Created commit-msg hook: ${hookPath}`);
    }

    // Make executable (no-op on Windows; Git for Windows handles this via Git Bash)
    try { fs.chmodSync(hookPath, "755"); } catch { /* Windows */ }
}

/** Install the global git commit-msg hook. */
function installGitHook() {
    console.log("\nGit commit-msg hook:");

    // Check if core.hooksPath is already set
    let existingPath = "";
    try {
        existingPath = execSync("git config --global core.hooksPath", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch {
        // Not set — we'll create our own
    }

    if (existingPath) {
        // Use existing hooksPath directory
        fs.mkdirSync(existingPath, { recursive: true });
        appendOrCreateHook(existingPath);
    } else {
        const hooksDir = path.join(os.homedir(), ".config", "ai-contribution-tracker", "git-hooks");
        fs.mkdirSync(hooksDir, { recursive: true });
        appendOrCreateHook(hooksDir);

        try {
            const gitPath = hooksDir.replace(/\\/g, "/");
            execFileSync("git", ["config", "--global", "core.hooksPath", gitPath], {
                encoding: "utf8",
                stdio: ["pipe", "pipe", "pipe"],
            });
            ok(`Set git global core.hooksPath: ${gitPath}`);
        } catch (e) {
            fail(`Could not set core.hooksPath: ${e.message}`);
        }
    }
}

// ─── OpenCode plugin registration ───────────────────────────

/** Add the plugin to the "plugin" array in an opencode.json file. */
function addPluginToConfig(configDir) {
    try {
        fs.mkdirSync(configDir, { recursive: true });
        const configPath = path.join(configDir, "opencode.json");

        let config = {};
        if (fs.existsSync(configPath)) {
            try {
                config = JSON.parse(fs.readFileSync(configPath, "utf8"));
            } catch {
                // Malformed JSON — back up and start fresh
                fs.copyFileSync(configPath, configPath + ".bak");
                warn(`Backed up malformed ${configPath} to ${configPath}.bak`);
                config = {};
            }
        }

        let plugins = config.plugin;
        if (!Array.isArray(plugins)) {
            plugins = [];
        }

        // Check if already registered (plain string or [name, options] tuple)
        const alreadyRegistered = plugins.some(
            (p) => (typeof p === "string" ? p : p[0]) === PLUGIN_NAME
        );

        if (alreadyRegistered) {
            skip(`Plugin already in: ${configPath}`);
            return;
        }

        plugins.push(PLUGIN_NAME);
        config.plugin = plugins;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        ok(`Added plugin to: ${configPath}`);
    } catch (e) {
        fail(`Could not update ${configDir}: ${e.message}`);
    }
}

function installOpenCodePlugin() {
    console.log("\nOpenCode plugin:");
    const configDir = path.join(os.homedir(), ".config", "opencode");
    addPluginToConfig(configDir);
}

// ─── Status check ───────────────────────────────────────────

function showStatus() {
    console.log("\nAI Contribution Tracker \u2014 Status\n");

    // Git hook
    let hooksPath = "";
    try {
        hooksPath = execSync("git config --global core.hooksPath", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch { /* not set */ }

    if (hooksPath) {
        const hookFile = path.join(hooksPath, "commit-msg");
        if (fs.existsSync(hookFile) && fs.readFileSync(hookFile, "utf8").includes(HOOK_MARKER)) {
            ok(`Git hook installed: ${hookFile}`);
        } else {
            warn(`core.hooksPath set to ${hooksPath} but no AI tracker snippet found`);
        }
    } else {
        warn("No global core.hooksPath set \u2014 git hook not installed");
    }

    // OpenCode plugin
    const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (fs.existsSync(configPath)) {
        try {
            const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
            const plugins = Array.isArray(config.plugin) ? config.plugin : [];
            const found = plugins.some(
                (p) => (typeof p === "string" ? p : p[0]) === PLUGIN_NAME
            );
            if (found) {
                ok(`OpenCode plugin registered: ${configPath}`);
            } else {
                warn(`opencode.json exists but plugin not in plugin array: ${configPath}`);
            }
        } catch {
            warn(`Could not parse: ${configPath}`);
        }
    } else {
        skip(`No opencode.json found at: ${configPath}`);
    }
}

// ─── Uninstall ──────────────────────────────────────────────

function removeGitHook() {
    console.log("\nGit commit-msg hook:");

    let hooksPath = "";
    try {
        hooksPath = execSync("git config --global core.hooksPath", {
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
    } catch { /* not set */ }

    if (!hooksPath) {
        skip("No global core.hooksPath set \u2014 nothing to remove");
        return;
    }

    const hookFile = path.join(hooksPath, "commit-msg");
    if (!fs.existsSync(hookFile)) {
        skip(`No commit-msg hook at: ${hookFile}`);
        return;
    }

    const content = fs.readFileSync(hookFile, "utf8");
    if (!content.includes(HOOK_MARKER)) {
        skip("commit-msg hook does not contain AI tracker snippet");
        return;
    }

    const lines = content.split("\n");
    const filtered = [];
    let skipping = false;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("AI Contribution Tracker")) {
            skipping = true;
            continue;
        }
        if (skipping) {
            if (lines[i].includes('rm "$STATE_FILE"')) {
                // consume the closing `fi` on the next non-empty line, then stop skipping
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].trim() === "fi") { i = j; break; }
                    if (lines[j].trim() !== "") { i = j - 1; break; }
                }
                skipping = false;
                continue;
            }
            continue;
        }
        filtered.push(lines[i]);
    }

    const remaining = filtered.join("\n").trim();
    if (remaining === "#!/bin/sh" || remaining === "") {
        fs.unlinkSync(hookFile);
        ok(`Removed commit-msg hook: ${hookFile}`);

        const ourDefaultDir = path.join(os.homedir(), ".config", "ai-contribution-tracker", "git-hooks");
        const normalizedHooksPath = hooksPath.replace(/\\/g, "/");
        const normalizedOurDir = ourDefaultDir.replace(/\\/g, "/");
        if (normalizedHooksPath === normalizedOurDir) {
            try {
                execFileSync("git", ["config", "--global", "--unset", "core.hooksPath"], {
                    encoding: "utf8",
                    stdio: ["pipe", "pipe", "pipe"],
                });
                ok("Unset git global core.hooksPath");
            } catch { }
        }
    } else {
        fs.writeFileSync(hookFile, remaining + "\n");
        ok(`Removed AI tracker snippet from: ${hookFile}`);
    }
}

function removeOpenCodePlugin() {
    console.log("\nOpenCode plugin:");

    const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (!fs.existsSync(configPath)) {
        skip("No opencode.json found");
        return;
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (!Array.isArray(config.plugin)) {
            skip("No plugin array in opencode.json");
            return;
        }

        const before = config.plugin.length;
        config.plugin = config.plugin.filter(
            (p) => (typeof p === "string" ? p : p[0]) !== PLUGIN_NAME
        );

        if (config.plugin.length === before) {
            skip("Plugin was not registered");
            return;
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
        ok(`Removed plugin from: ${configPath}`);
    } catch (e) {
        fail(`Could not update ${configPath}: ${e.message}`);
    }
}

// ─── Main ───────────────────────────────────────────────────

function printUsage() {
    console.log(`
AI Contribution Tracker \u2014 CLI Installer

Installs git hooks and OpenCode plugin without requiring VS Code.
Works on macOS, Linux, and Windows.

Usage:
  npx ${PLUGIN_NAME} init      Install git hook + register OpenCode plugin
  npx ${PLUGIN_NAME} status    Show installation status
  npx ${PLUGIN_NAME} remove    Uninstall git hook + unregister plugin
  npx ${PLUGIN_NAME} --help    Show this help message

What gets installed:
  1. Global git commit-msg hook (tags every AI-assisted commit)
  2. OpenCode plugin entry in ~/.config/opencode/opencode.json
`);
}

const command = process.argv[2];

switch (command) {
    case "init":
    case "install":
        console.log("\nAI Contribution Tracker \u2014 Installing...\n");
        console.log(`Platform: ${process.platform} (${os.arch()})`);
        installGitHook();
        installOpenCodePlugin();
        console.log("\nDone. All future AI-assisted commits will be tagged automatically.\n");
        break;

    case "status":
        showStatus();
        break;

    case "remove":
    case "uninstall":
        console.log("\nAI Contribution Tracker \u2014 Removing...");
        removeGitHook();
        removeOpenCodePlugin();
        console.log("\nDone.\n");
        break;

    case "--help":
    case "-h":
    case "help":
        printUsage();
        break;

    default:
        if (command) {
            console.error(`Unknown command: ${command}\n`);
        }
        printUsage();
        process.exit(command ? 1 : 0);
}

