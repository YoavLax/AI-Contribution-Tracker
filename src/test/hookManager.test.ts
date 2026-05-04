import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { CommitHookManager } from '../commitHookManager';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class SilentLogger implements vscode.OutputChannel {
    name = 'SilentLogger';
    lines: string[] = [];
    append(value: string): void { this.lines.push(value); }
    appendLine(value: string): void { this.lines.push(value); }
    replace(): void {}
    clear(): void { this.lines = []; }
    show(): void {}
    hide(): void {}
    dispose(): void {}
}

const tempDirs: string[] = [];

function createTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-manager-test-'));
    tempDirs.push(dir);
    return dir;
}

function initGitRepo(dir: string): void {
    cp.execSync('git init', { cwd: dir, stdio: 'pipe' });
    cp.execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    cp.execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
}

function hookFilePath(repoRoot: string): string {
    return path.join(repoRoot, '.git', 'hooks', 'commit-msg');
}

function fakeWorkspaceFolders(dirs: string[]): readonly vscode.WorkspaceFolder[] {
    return dirs.map((dir, i) => ({
        uri: vscode.Uri.file(dir),
        name: path.basename(dir),
        index: i,
    }));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite('CommitHookManager', function () {
    this.timeout(10000);

    let logger: SilentLogger;
    let manager: CommitHookManager;

    setup(() => {
        logger = new SilentLogger();
        manager = new CommitHookManager(logger);
    });

    teardown(() => {
        manager.dispose();
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // -----------------------------------------------------------------------

    test('installForWorkspace installs hook in a git repository', async () => {
        const repoDir = createTempDir();
        initGitRepo(repoDir);

        const stub = sinon_workspaceFolders(fakeWorkspaceFolders([repoDir]));
        try {
            manager.installForWorkspace();
        } finally {
            stub.restore();
        }

        const hookFile = hookFilePath(repoDir);
        assert.ok(fs.existsSync(hookFile), 'commit-msg hook should be created');

        const content = fs.readFileSync(hookFile, 'utf8');
        assert.ok(content.includes('AI_IMPACT_PENDING'), 'Hook should reference AI_IMPACT_PENDING');
        assert.ok(content.includes('Managed by AI Contribution Tracker'), 'Hook should contain ownership marker');

        if (os.platform() !== 'win32') {
            const mode = fs.statSync(hookFile).mode;
            assert.ok((mode & 0o111) !== 0, 'Hook should be executable');
        }
    });

    // -----------------------------------------------------------------------

    test('installForWorkspace skips a folder that is not a git repository', () => {
        const plainDir = createTempDir();  // no git init

        const stub = sinon_workspaceFolders(fakeWorkspaceFolders([plainDir]));
        try {
            manager.installForWorkspace();
        } finally {
            stub.restore();
        }

        assert.ok(!fs.existsSync(path.join(plainDir, '.git', 'hooks', 'commit-msg')));
        assert.ok(logger.lines.some(l => l.includes('not inside a git repository')));
    });

    // -----------------------------------------------------------------------

    test('installForWorkspace does not overwrite a foreign hook', () => {
        const repoDir = createTempDir();
        initGitRepo(repoDir);

        const hooksDir = path.join(repoDir, '.git', 'hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        const foreignContent = '#!/bin/sh\necho "foreign hook"\n';
        fs.writeFileSync(hookFilePath(repoDir), foreignContent);

        const stub = sinon_workspaceFolders(fakeWorkspaceFolders([repoDir]));
        try {
            manager.installForWorkspace();
        } finally {
            stub.restore();
        }

        const content = fs.readFileSync(hookFilePath(repoDir), 'utf8');
        assert.strictEqual(content, foreignContent, 'Foreign hook must not be modified');
        assert.ok(logger.lines.some(l => l.includes('belongs to another tool')));
    });

    // -----------------------------------------------------------------------

    test('dispose removes hooks that were installed by this manager', () => {
        const repoDir = createTempDir();
        initGitRepo(repoDir);

        const stub = sinon_workspaceFolders(fakeWorkspaceFolders([repoDir]));
        try {
            manager.installForWorkspace();
        } finally {
            stub.restore();
        }

        assert.ok(fs.existsSync(hookFilePath(repoDir)), 'Pre-condition: hook should exist');

        manager.dispose();

        assert.ok(!fs.existsSync(hookFilePath(repoDir)), 'Hook should be removed after dispose');
    });

    // -----------------------------------------------------------------------

    test('dispose does not remove a foreign hook', () => {
        const repoDir = createTempDir();
        initGitRepo(repoDir);

        const hooksDir = path.join(repoDir, '.git', 'hooks');
        fs.mkdirSync(hooksDir, { recursive: true });
        const foreignContent = '#!/bin/sh\necho "foreign"\n';
        fs.writeFileSync(hookFilePath(repoDir), foreignContent);

        // Nothing was installed by us, but call dispose anyway
        manager.dispose();

        assert.strictEqual(fs.readFileSync(hookFilePath(repoDir), 'utf8'), foreignContent);
    });

    // -----------------------------------------------------------------------

    test('installForWorkspace deduplicates multiple folders sharing one git root', () => {
        const repoDir = createTempDir();
        initGitRepo(repoDir);

        // Two sub-folders inside the same repo
        const subA = path.join(repoDir, 'packages', 'a');
        const subB = path.join(repoDir, 'packages', 'b');
        fs.mkdirSync(subA, { recursive: true });
        fs.mkdirSync(subB, { recursive: true });

        const stub = sinon_workspaceFolders(fakeWorkspaceFolders([subA, subB]));
        try {
            manager.installForWorkspace();
        } finally {
            stub.restore();
        }

        // installInRepo logs one line per actual install — verify it fired exactly once
        const installLogs = logger.lines.filter(l => l.includes('Installed commit-msg hook'));
        assert.strictEqual(installLogs.length, 1, 'Hook should be installed exactly once for the shared root');
        assert.ok(fs.existsSync(hookFilePath(repoDir)), 'Hook file should exist');
    });

    // -----------------------------------------------------------------------

    test('migrateFromLegacyGlobalSetup clears legacy core.hooksPath when it matches', () => {
        const legacyBase = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-hooks-base-'));
        const legacyDir = path.join(legacyBase, 'git-hooks');
        fs.mkdirSync(legacyDir, { recursive: true });

        // Capture the current global hooksPath so we can restore it after the test
        let originalHooksPath: string | undefined;
        try {
            originalHooksPath = cp.execSync('git config --global core.hooksPath', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch {
            originalHooksPath = undefined;
        }

        cp.execSync(`git config --global core.hooksPath "${legacyDir}"`, { stdio: ['pipe', 'pipe', 'pipe'] });

        try {
            const mockContext = {
                globalStorageUri: { fsPath: legacyBase },
            } as unknown as vscode.ExtensionContext;

            manager.migrateFromLegacyGlobalSetup(mockContext);

            let result = '';
            try {
                result = cp.execSync('git config --global core.hooksPath', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            } catch {
                // unset is expected — result stays ''
            }
            assert.strictEqual(result, '', 'Global core.hooksPath should be cleared after migration');
            assert.ok(logger.lines.some(l => l.includes('Cleared legacy')), 'Log should mention clearing legacy path');
        } finally {
            // Restore global git config to its original state
            if (originalHooksPath !== undefined) {
                cp.execSync(`git config --global core.hooksPath "${originalHooksPath}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
            } else {
                try { cp.execSync('git config --global --unset core.hooksPath', { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { /* already unset */ }
            }
            fs.rmSync(legacyBase, { recursive: true, force: true });
        }
    });

    // -----------------------------------------------------------------------

    test('migrateFromLegacyGlobalSetup does nothing when hooksPath points elsewhere', () => {
        // Capture original state
        let originalHooksPath: string | undefined;
        try {
            originalHooksPath = cp.execSync('git config --global core.hooksPath', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch {
            originalHooksPath = undefined;
        }

        const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unrelated-hooks-'));
        cp.execSync(`git config --global core.hooksPath "${unrelatedDir}"`, { stdio: ['pipe', 'pipe', 'pipe'] });

        try {
            const mockContext = {
                globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'ext-storage-')) },
            } as unknown as vscode.ExtensionContext;

            manager.migrateFromLegacyGlobalSetup(mockContext);

            const result = cp.execSync('git config --global core.hooksPath', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
            assert.strictEqual(result, unrelatedDir, 'Unrelated hooksPath must not be modified');
            assert.ok(!logger.lines.some(l => l.includes('Cleared legacy')), 'No migration log should appear');
        } finally {
            if (originalHooksPath !== undefined) {
                cp.execSync(`git config --global core.hooksPath "${originalHooksPath}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
            } else {
                try { cp.execSync('git config --global --unset core.hooksPath', { stdio: ['pipe', 'pipe', 'pipe'] }); } catch { /* already unset */ }
            }
            fs.rmSync(unrelatedDir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Minimal sinon-style stub for vscode.workspace.workspaceFolders
// (avoids pulling in sinon as a dev-dependency)
// ---------------------------------------------------------------------------

function sinon_workspaceFolders(value: readonly vscode.WorkspaceFolder[]): { restore(): void } {
    const original = Object.getOwnPropertyDescriptor(vscode.workspace, 'workspaceFolders');
    Object.defineProperty(vscode.workspace, 'workspaceFolders', { get: () => value, configurable: true });
    return {
        restore() {
            if (original) {
                Object.defineProperty(vscode.workspace, 'workspaceFolders', original);
            }
        },
    };
}
