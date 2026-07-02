/**
 * `ai-track hook` — the runtime handler invoked by git hooks and agent
 * lifecycle hooks (Copilot CLI, VS Code Copilot, Claude Code).
 *
 * It reads a JSON hook payload on stdin and delegates to the SAME core logic
 * used by the VS Code extension (src/hook-handler.ts), guaranteeing identical
 * session/token/model tracking and marker formatting — no data is missed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { dataDir } from "./paths.ts";
import { dispatch, type HookInput } from "../../../src/hook-handler.ts";

export function runHook(): void {
    // Point the shared core at the binary's own data directory (unless a caller
    // has already set one, e.g. tests).
    if (!process.env.AI_TRACKER_DATA_DIR) {
        process.env.AI_TRACKER_DATA_DIR = dataDir();
    }

    let inputData = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { inputData += chunk; });
    process.stdin.on("end", () => {
        try {
            const input = JSON.parse(inputData) as HookInput;

            // Best-effort debug log (never breaks hook execution).
            try {
                const debugLogPath = path.join(os.tmpdir(), "ai-commit-tracker-debug.log");
                const eventName = input.hookEventName || input.hook_event_name || "?";
                fs.appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${eventName} ${inputData.trim()}\n`);
            } catch { /* ignore logging failures */ }

            const result = dispatch(input);
            process.stdout.write(JSON.stringify(result));
            process.exit(0);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`ai-track hook error: ${message}\n`);
            // Non-blocking: exit 1 (warning) so the agent/commit is never blocked.
            process.exit(1);
        }
    });
}
