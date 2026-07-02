#!/usr/bin/env node
/**
 * ai-track — standalone AI Contribution Tracker CLI.
 *
 * Self-contained: bundles the same core session/token/model logic used by the
 * VS Code extension (src/hook-handler.ts) so no data is ever missed, and
 * requires no external runtime when shipped as a Bun-compiled binary.
 */
import { runInit } from "./install.ts";
import { runHook } from "./hook.ts";
import { runStatus } from "./status.ts";
import { runRemove } from "./remove.ts";
import { runUpdate } from "./update.ts";

const VERSION = "0.1.2";

function printUsage(unknown?: string): void {
    if (unknown) { console.error(`Unknown command: ${unknown}\n`); }
    console.log(`
AI Contribution Tracker (ai-track) v${VERSION}

Tags every AI-assisted git commit with model, token, and prompt metadata.
Works with VS Code Copilot, GitHub Copilot CLI, Claude Code, and OpenCode.

Usage:
  ai-track init       Install git hook + agent hooks + enable token tracking
  ai-track status     Show installation status
  ai-track doctor     Verify and repair the installation
  ai-track remove     Uninstall hooks + plugin
  ai-track update     Download and install the latest binary
  ai-track version    Print version
  ai-track hook       (internal) Handle a hook event on stdin
`);
}

async function main(): Promise<void> {
    const cmd = process.argv[2];
    switch (cmd) {
        case "hook":
            runHook();
            break;
        case "init":
        case "install":
            runInit();
            break;
        case "doctor":
            runInit({ doctor: true });
            break;
        case "status":
            runStatus();
            break;
        case "remove":
        case "uninstall":
            runRemove();
            break;
        case "update":
            await runUpdate();
            break;
        case "version":
        case "--version":
        case "-v":
            console.log(VERSION);
            break;
        case "help":
        case "--help":
        case "-h":
        case undefined:
            printUsage();
            break;
        default:
            printUsage(cmd);
            process.exit(1);
    }
}

main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
