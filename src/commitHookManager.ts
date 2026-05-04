import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const HOOK_OWNERSHIP_MARKER = '# Managed by AI Contribution Tracker';
const HOOK_FILE_NAME = 'commit-msg';
const LEGACY_GLOBAL_HOOKS_SUBDIR = 'git-hooks';

export class CommitHookManager implements vscode.Disposable {
    private readonly installedRoots: string[] = [];

    constructor(private readonly logger: vscode.OutputChannel) {}

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
     * Removes every hook this instance installed. Hooks owned by other tools
     * are never touched.
     */
    dispose(): void {
        for (const root of this.installedRoots) {
            this.removeFromRepo(root);
        }
        this.installedRoots.length = 0;
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
            this.installedRoots.push(gitRoot);
            this.logger.appendLine(`[Hooks] Installed commit-msg hook in ${gitRoot}`);
        } catch (error) {
            this.logger.appendLine(`[Hooks] Failed to install hook in ${gitRoot}: ${error}`);
            vscode.window.showWarningMessage(
                `AI Contribution Tracker: Could not install git hook in ${gitRoot}.`,
                'Show Logs'
            ).then(choice => { if (choice === 'Show Logs') { this.logger.show(); } });
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
            '    if ! grep -q "$MARKER" "$1"; then',
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
