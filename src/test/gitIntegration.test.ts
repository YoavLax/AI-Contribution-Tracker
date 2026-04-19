import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { CopilotTracker } from '../tracker';

function runGit(args: string[], cwd: string): string {
    return cp.execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8' });
}

// Mock logger to verify internal state
class TestLogger implements vscode.OutputChannel {
    name = "TestLogger";
    lines: string[] = [];
    append(value: string): void { this.lines.push(value); }
    appendLine(value: string): void { this.lines.push(value); }
    replace(value: string): void {}
    clear(): void { this.lines = []; }
    show(): void {}
    hide(): void {}
    dispose(): void {}
}

suite('Git Integration Tests (Deterministic Only)', function () {
    this.timeout(10000); // Higher timeout for Git operations

    let repoRoot: string;
    let tracker: CopilotTracker;
    let logger: TestLogger; 
    let testFileUri: vscode.Uri;

    // Use Suite Setup to create repo ONCE to avoid Git Extension confusion with multiple temp repos
    suiteSetup(async () => {
        // 1. Create unique temp folder for repo
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-test-repo-'));
        
        // 2. Init Git Repo
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);

        // 3. Force Git Extension to open this repo
        const gitExt = vscode.extensions.getExtension('vscode.git');
        if (gitExt) {
            const git = gitExt.exports.getAPI(1);
            if (git.openRepository) {
                 await git.openRepository(vscode.Uri.file(repoRoot));
            }
        }

        // 4. Activate Extension & Setup Tracker Once
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        const api = await ext!.activate();
        tracker = api.tracker;
        
        // Mock API
        const mockRepo = { rootUri: vscode.Uri.file(repoRoot) };
        const mockGitAPI = {
            repositories: [mockRepo],
            getRepository: (uri: vscode.Uri) => {
                // Simple match for test
                if (uri.fsPath.toLowerCase().startsWith(repoRoot.toLowerCase())) {
                    return mockRepo;
                }
                return null;
            }
        };

        if (tracker) {
            tracker.setGitAPI(mockGitAPI as any);
            
            logger = new TestLogger();
            (tracker as any).logger = logger;
            
            // Register test commands ONCE
            if (typeof (tracker as any).registerTestCommands === 'function') {
                try {
                    (tracker as any).registerTestCommands();
                } catch (e) { 
                    // Ignore if already registered
                    console.log('Test triggers already registered');
                }
            }
        } else {
            console.error('Tracker not found in API!');
        }
    });

    suiteTeardown(() => {
        // Cleanup temp folder (recursive delete)
        if (fs.existsSync(repoRoot)) {
            try {
                // fs.rmSync(repoRoot, { recursive: true, force: true });
            } catch (e) { console.error('Cleanup failed', e); }
        }
    });

    setup(async () => {
        // Create/Reset file for each test
        const filePath = path.join(repoRoot, 'test.txt');
        fs.writeFileSync(filePath, 'Initial Content\n');
        try {
            runGit(['add', 'test.txt'], repoRoot);
            runGit(['commit', '-m', '"Reset commit"'], repoRoot);
        } catch (e) { /* ignore if no changes */ }

        // Normalize URI on Windows to match what VS Code will likely use
        testFileUri = vscode.Uri.file(filePath);
        
        // Open the document
        const doc = await vscode.workspace.openTextDocument(testFileUri);
        await vscode.window.showTextDocument(doc);
    });

    teardown(() => {
        // tracker.dispose(); // DO NOT Dispose global tracker
        // Clear pending flag if exists to not pollute next test
        const gitDir = path.join(repoRoot, '.git');
        const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
        if (fs.existsSync(flagFile)) {fs.rmSync(flagFile);}
        
        // Close editor
        vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });

    // Helper to simulate manual typing/pasting (NO Flag Trigger)
    async function simulateManualEdit(text: string) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {throw new Error('No active editor');}
        
        await editor.edit(editBuilder => {
            const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
            editBuilder.insert(lastLine.range.end, "\n" + text);
        });
        
        await editor.document.save();
        await new Promise(r => setTimeout(r, 500)); // Wait for async events
    }

    // Helper to simulate AI Acceptance
    // 1. Triggers the Command (sets flag)
    // 2. IMMEDIATELY performs the edit (simulating the command's effect)
    async function simulateAIAccept(text: string, command: string = 'copilotInsightTracker.acceptInlineSuggestion') {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {throw new Error('No active editor');}
        
        // 1. Trigger the tracker command. 
        const cmdPromise = vscode.commands.executeCommand(command);
        
        // Give the command handler a moment to start and set the flag
        await new Promise(r => setTimeout(r, 100));

        // 2. Simulate the text insertion "caused" by the command
        await editor.edit(editBuilder => {
            const lastLine = editor.document.lineAt(editor.document.lineCount - 1);
            editBuilder.insert(lastLine.range.end, "\n" + text);
        });
        
        await cmdPromise; // Ensure command cycle finished
        
        await editor.document.save();
        await new Promise(r => setTimeout(r, 500)); // Wait for async events
    }

    test('Scenario: Manual Edit Should NOT Mark Commit', async () => {
        await simulateManualEdit("Manual content");
        
        const gitDir = path.join(repoRoot, '.git');
        const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
        
        assert.strictEqual(fs.existsSync(flagFile), false, 'Manual edit should NOT create pending flag');
    });

    test('Scenario: AI Inline Acceptance Should Mark Commit', async () => {
        // Use testTrigger proxy to ensure we are testing the Tracker logic
        await simulateAIAccept("const ai = true;", 'copilotInsightTracker.testTrigger');
        
        const gitDir = path.join(repoRoot, '.git');
        const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
        
        if (!fs.existsSync(flagFile)) {
            if (logger && logger.lines) {
                 console.log('DEBUG LOGS:', logger.lines.join('\n'));
            }
        }
        
        assert.ok(fs.existsSync(flagFile), 'AI acceptance should create pending flag');
        const flagContent = fs.readFileSync(flagFile, 'utf-8');
        assert.ok(flagContent.includes('Impacted by AI'), 'Flag content should contain marker');
        assert.ok(flagContent.includes('Inline'), 'Flag content should contain Inline marker');
        
        // Check Commit Message
        runGit(['add', '.'], repoRoot);
        runGit(['commit', '-m', '"AI Feature"'], repoRoot);
        const log = runGit(['log', '-1', '--pretty=%B'], repoRoot);
        assert.ok(log.includes('Impacted by AI'), 'Commit message should contain the marker');
    });

    // Chat test removed as we cannot deterministically intercept non-keyboard Apply actions
    // test('Scenario: AI Chat Apply Should Mark Commit', async () => { ... });

    test('Scenario: "SortLines" (Simulated Agent-like edit but NO command) Should NOT Mark', async () => {
        const largeCode = `
        function sort() {
            return [1, 2, 3].sort();
        }
        `;
        
        await simulateManualEdit(largeCode);
        
        const gitDir = path.join(repoRoot, '.git');
        const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
        
        assert.strictEqual(fs.existsSync(flagFile), false, 'Large code insertion without command should NOT be marked');
    });

    test('Scenario: Copy-Paste (Simulated) Should NOT Mark', async () => {
        const pasteText = "Copied Text";
        await vscode.env.clipboard.writeText(pasteText);
        
        await simulateManualEdit(pasteText);
        
        const gitDir = path.join(repoRoot, '.git');
        assert.strictEqual(fs.existsSync(path.join(gitDir, 'AI_IMPACT_PENDING')), false);
    });
});
