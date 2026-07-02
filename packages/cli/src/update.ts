/**
 * `ai-track update` — download the latest binary for this platform from GitHub
 * raw hosting and replace the installed one.
 */
import * as fs from "fs";
import * as path from "path";
import { binDir, binaryName, ok, warn, fail } from "./paths.ts";

// GitHub raw hosting base. Binaries are published under bin/<asset> on the
// default branch. Override with AI_TRACK_RAW_BASE for testing/forks.
const RAW_BASE =
    process.env.AI_TRACK_RAW_BASE ||
    "https://raw.githubusercontent.com/YoavLax/AI-Contribution-Tracker/main/bin";

function assetName(): string {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    if (process.platform === "win32") { return `ai-track-win-${arch}.exe`; }
    if (process.platform === "darwin") { return `ai-track-darwin-${arch}`; }
    return `ai-track-linux-${arch}`;
}

export async function runUpdate(): Promise<void> {
    console.log("\nAI Contribution Tracker (ai-track) \u2014 Updating...\n");
    const url = `${RAW_BASE}/${assetName()}`;
    console.log(`Downloading: ${url}`);

    try {
        const res = await fetch(url);
        if (!res.ok) {
            fail(`Download failed: HTTP ${res.status}`);
            return;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const dir = binDir();
        fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, binaryName());

        if (process.platform === "win32") {
            // The running .exe can't be overwritten; stage next to it.
            const staged = target + ".new";
            fs.writeFileSync(staged, buf);
            warn(`New binary staged at ${staged}.`);
            warn(`Close this process, then replace ${target} with it.`);
        } else {
            const tmp = target + ".tmp";
            fs.writeFileSync(tmp, buf);
            fs.chmodSync(tmp, "755");
            fs.renameSync(tmp, target);
            ok(`Updated: ${target}`);
        }
    } catch (e) {
        fail(`Update failed: ${(e as Error).message}`);
    }
}
