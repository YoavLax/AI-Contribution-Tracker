/**
 * Cross-compile the `ai-track` binary for all supported platforms using Bun.
 * Output goes to ../../bin/; CI attaches these to the GitHub Release.
 *
 * Run with: bun run scripts/build-binaries.ts
 */
import { $ } from "bun";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const ENTRY = path.join(ROOT, "src", "cli.ts");
const OUT_DIR = path.resolve(ROOT, "..", "..", "bin");

const TARGETS: Array<{ target: string; asset: string }> = [
    { target: "bun-linux-x64", asset: "ai-track-linux-x64" },
    { target: "bun-linux-arm64", asset: "ai-track-linux-arm64" },
    { target: "bun-darwin-x64", asset: "ai-track-darwin-x64" },
    { target: "bun-darwin-arm64", asset: "ai-track-darwin-arm64" },
    { target: "bun-windows-x64", asset: "ai-track-win-x64.exe" },
];

for (const { target, asset } of TARGETS) {
    const outfile = path.join(OUT_DIR, asset);
    console.log(`Building ${asset} (${target})...`);
    await $`bun build ${ENTRY} --compile --target=${target} --outfile=${outfile} --external bun:sqlite --external node:sqlite`;

    if (target.startsWith("bun-darwin")) {
        try {
            await $`codesign --sign - --force ${outfile}`.quiet();
            console.log(`  ad-hoc signed ${asset}`);
        } catch {
            console.log(`  (codesign unavailable — ${asset} will be signed by the installer)`);
        }
    }
}

console.log(`\nDone. Binaries written to ${OUT_DIR}`);
