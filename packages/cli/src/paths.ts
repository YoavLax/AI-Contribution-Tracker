/**
 * Cross-platform path resolution for the standalone `ai-track` binary.
 *
 * All tracker state lives under a single home directory so the binary is fully
 * self-contained and easy to remove:
 *   Windows: %LOCALAPPDATA%\ai-track\
 *   Unix:    ~/.ai-track/
 */
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

/** Root directory for everything this tool installs. */
export function trackerHome(): string {
    if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
        return path.join(local, "ai-track");
    }
    return path.join(os.homedir(), ".ai-track");
}

/**
 * Directory the core hook logic uses for cross-repo state
 * (pending/, session-repo-map.json, active-workspace.json).
 * Exported to the core via the AI_TRACKER_DATA_DIR env var.
 */
export function dataDir(): string {
    const d = path.join(trackerHome(), "data");
    fs.mkdirSync(d, { recursive: true });
    return d;
}

/** Fallback git hooks directory used when core.hooksPath is not already set. */
export function defaultGitHooksDir(): string {
    return path.join(trackerHome(), "git-hooks");
}

/** Directory the binary is installed into (added to PATH by the install script). */
export function binDir(): string {
    if (process.platform === "win32") {
        return path.join(trackerHome(), "bin");
    }
    return path.join(os.homedir(), ".local", "bin");
}

/** The platform-appropriate binary filename. */
export function binaryName(): string {
    return process.platform === "win32" ? "ai-track.exe" : "ai-track";
}

/**
 * Absolute path to the currently running executable, for embedding into hook
 * scripts. For a Bun-compiled single binary this is the binary itself.
 */
export function selfPath(): string {
    return process.execPath;
}

/** Convert a Windows path to a forward-slash form Git's POSIX shell can execute. */
export function toPosix(p: string): string {
    return p.replace(/\\/g, "/");
}

/**
 * VS Code User settings.json locations across stable + Insiders on all
 * platforms. Used to enable the Copilot OTEL span exporter without the extension.
 */
export function vscodeUserSettingsPaths(): string[] {
    const home = os.homedir();
    let bases: string[];
    if (process.platform === "win32") {
        const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
        bases = [path.join(appData, "Code"), path.join(appData, "Code - Insiders")];
    } else if (process.platform === "darwin") {
        const root = path.join(home, "Library", "Application Support");
        bases = [path.join(root, "Code"), path.join(root, "Code - Insiders")];
    } else {
        const root = path.join(home, ".config");
        bases = [path.join(root, "Code"), path.join(root, "Code - Insiders")];
    }
    return bases.map((b) => path.join(b, "User", "settings.json"));
}

// ─── Logging helpers ────────────────────────────────────────
export function ok(msg: string): void { console.log(`  \u2713 ${msg}`); }
export function skip(msg: string): void { console.log(`  - ${msg}`); }
export function warn(msg: string): void { console.log(`  ! ${msg}`); }
export function fail(msg: string): void { console.error(`  \u2717 ${msg}`); }
