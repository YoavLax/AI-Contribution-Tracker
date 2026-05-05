import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const HOOK_OWNERSHIP_MARKER = '# Managed by AI Contribution Tracker';
const HOOK_FILE_NAME = 'commit-msg';
const LEGACY_GLOBAL_HOOKS_SUBDIR = 'git-hooks';
const GLOBAL_STATE_KEY = 'installedHookRoots';

export class CommitHookManager implements vscode.Disposable {
    /** Roots installed during this VS Code session only (subset of persisted set). */
    private readonly sessionRoots: string[] = [];

    constructor(
        private readonly logger: vscode.OutputChannel,
        private readonly globalState: vscode.Memento,
    ) {}

    /**
     * Installs the commit-msg hook into every git repository found in the
     * current workspace. Repos that already have a foreign hook are skipped.
     */
    installForWorkspace(): void {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.logger.appendLine('[Hooks] No workspace folders — skipping hook installation');
            return;
        }

        const uniqueRoots = this.resolveUniqueGitRoots(folders);
        for (const root of uniqueRoots) {
            this.installInRepo(root);
        }
    }

    /**
     * Removes the machine-wide core.hooksPath override left by earlier versions
     * of this extension. Does nothing if the setting points elsewhere.
     */
    migrateFromLegacyGlobalSetup(context: vscode.ExtensionContext): void {
        const legacyDir = path.join(context.globalStorageUri.fsPath, LEGACY_GLOBAL_HOOKS_SUBDIR);
        const current = this.readGlobalHooksPath();

        if (current !== legacyDir) {
            return;
        }

        try {
            execSync('git config --global --unset core.hooksPath', { stdio: ['pipe', 'pipe', 'pipe'] });
            this.logger.appendLine('[Hooks] Cleared legacy global core.hooksPath — migrated to per-workspace hooks');
            vscode.window.showInformationMessage(
                'AI Contribution Tracker: Migrated to per-workspace git hooks. Other repositories are no longer affected.'
            );
        } catch (error) {
            this.logger.appendLine(`[Hooks] Failed to unset legacy core.hooksPath: ${error}`);
        }
    }

    /**
     * Removes every hook this extension ever installed — including roots from
     * previous VS Code sessions that were persisted in globalState. Called
     * automatically when the extension deactivates via `context.subscriptions`.
     *
     * Since AI_IMPACT_PENDING is only written while VS Code is running, hooks
     * being absent after VS Code closes is intentional — no git operation is
     * ever silently missed. Hooks owned by other tools are never touched.
     *
     * Known limitation: if two VS Code windows are open simultaneously and the
     * extension is uninstalled from one, that window's dispose() will attempt to
     * remove hooks for ALL persisted roots, including repos open in the other
     * window. Fixing this cleanly requires per-session ownership tracking and
     * is out of scope.
     */
    dispose(): void {
        const allRoots = this.readPersistedRoots();
        for (const root of allRoots) {
            this.removeFromRepo(root);
        }
        this.persistRoots(new Set());
        this.sessionRoots.length = 0;
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private resolveUniqueGitRoots(folders: readonly vscode.WorkspaceFolder[]): Set<string> {
        const roots = new Set<string>();
        for (const folder of folders) {
            const root = this.findGitRoot(folder.uri.fsPath);
            if (root) {
                roots.add(root);
            }
        }
        return roots;
    }

    private findGitRoot(folderPath: string): string | null {
        try {
            return execSync('git rev-parse --show-toplevel', {
                cwd: folderPath,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch {
            this.logger.appendLine(`[Hooks] ${folderPath} is not inside a git repository — skipping`);
            return null;
        }
    }

    private installInRepo(gitRoot: string): void {
        const hookFile = this.hookFilePath(gitRoot);
        const existingContent = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : '';

        if (existingContent && !this.isOwnedByExtension(existingContent)) {
            this.logger.appendLine(`[Hooks] Skipping ${gitRoot} — commit-msg hook belongs to another tool`);
            return;
        }

        try {
            fs.mkdirSync(path.dirname(hookFile), { recursive: true });
            fs.writeFileSync(hookFile, this.buildHookScript());
            if (os.platform() !== 'win32') {
                fs.chmodSync(hookFile, '755');
            }
            if (!this.sessionRoots.includes(gitRoot)) {
                this.sessionRoots.push(gitRoot);
            }
            this.addPersistedRoot(gitRoot);
            this.logger.appendLine(`[Hooks] Installed commit-msg hook in ${gitRoot}`);
        } catch (error) {
            this.logger.appendLine(`[Hooks] Failed to install hook in ${gitRoot}: ${error}`);
            vscode.window.showWarningMessage(
                `AI Contribution Tracker: Could not install git hook in ${gitRoot}.`,
                'Show Logs'
            ).then((choice: string | undefined) => { if (choice === 'Show Logs') { this.logger.show(); } });
        }
    }

    private removeFromRepo(gitRoot: string): void {
        const hookFile = this.hookFilePath(gitRoot);
        if (!fs.existsSync(hookFile)) {
            return;
        }
        const content = fs.readFileSync(hookFile, 'utf8');
        if (!this.isOwnedByExtension(content)) {
            return;
        }
        try {
            fs.unlinkSync(hookFile);
            this.logger.appendLine(`[Hooks] Removed commit-msg hook from ${gitRoot}`);
        } catch (error) {
            this.logger.appendLine(`[Hooks] Failed to remove hook from ${gitRoot}: ${error}`);
        }
    }

    private readPersistedRoots(): Set<string> {
        return new Set(this.globalState.get<string[]>(GLOBAL_STATE_KEY, []));
    }

    private persistRoots(roots: Set<string>): void {
        this.globalState.update(GLOBAL_STATE_KEY, [...roots]);
    }

    private addPersistedRoot(gitRoot: string): void {
        const roots = this.readPersistedRoots();
        roots.add(gitRoot);
        this.persistRoots(roots);
    }

    private isOwnedByExtension(hookContent: string): boolean {
        return hookContent.includes(HOOK_OWNERSHIP_MARKER);
    }

    private hookFilePath(gitRoot: string): string {
        return path.join(gitRoot, '.git', 'hooks', HOOK_FILE_NAME);
    }

    private buildHookScript(): string {
        return [
            '#!/bin/sh',
            HOOK_OWNERSHIP_MARKER,
            '',
            'IMPACT_FLAG=$(git rev-parse --git-path AI_IMPACT_PENDING)',
            '',
            'if [ -f "$IMPACT_FLAG" ]; then',
            '    MARKER=$(cat "$IMPACT_FLAG")',
            '    if [ -z "$MARKER" ]; then',
            '        MARKER="Impacted by AI"',
            '    fi',
            '    if ! grep -qF "$MARKER" "$1"; then',
            '        echo "" >> "$1"',
            '        echo "$MARKER" >> "$1"',
            '    fi',
            '    rm "$IMPACT_FLAG"',
            'fi',
        ].join('\n') + '\n';
    }

    private readGlobalHooksPath(): string {
        try {
            return execSync('git config --global core.hooksPath', {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            }).trim();
        } catch {
            return '';
        }
    }
}
