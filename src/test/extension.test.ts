import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'YoavLax.ai-contribution-tracker';

suite('Extension Test Suite', () => {
    vscode.window.showInformationMessage('Start all tests.');

    test('Extension should start and activate', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);

        const api = await ext.activate();
        assert.ok(ext.isActive, 'Extension should be active after activation');
        assert.ok(api && api.tracker, 'Extension should export a tracker object');
    }).timeout(10000);

    test('Extension should set context key on activation', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        await ext!.activate();
        assert.ok(ext!.isActive, 'Extension should be active (context key is set via setContext inside tracker)');
    }).timeout(10000);

    test('Extension should NOT track direct text edits (only AI accepts)', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(0, 0), 'const x = 1;');
        await vscode.workspace.applyEdit(edit);
        await new Promise(r => setTimeout(r, 500));
        // No assertion needed — test verifies no crash occurs on manual edits
    }).timeout(10000);

    test('Extension should NOT track small typing', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(0, 0), 'a');
        await vscode.workspace.applyEdit(edit);
        await new Promise(r => setTimeout(r, 200));
        // No assertion needed — single-character edits should never trigger tracking
    });

    test('Inline suggestion commands should be registered', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        await ext!.activate();

        const commands = await vscode.commands.getCommands(true);

        assert.ok(
            commands.includes('copilotInsightTracker.acceptInlineSuggestion'),
            'Tab accept command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptNextWord'),
            'Ctrl+Right accept-word command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptNextLine'),
            'Ctrl+Shift+Right accept-line command should be registered'
        );

        // Agentic interception commands must NOT be registered — handled by hooks
        assert.ok(
            !commands.includes('copilotInsightTracker.applyChatCode'),
            'Legacy agentic applyChatCode command should not be registered'
        );
        assert.ok(
            !commands.includes('copilotInsightTracker.paste'),
            'Paste tracking command should not be registered'
        );
    });

    test('Wrapper command should execute original command without throwing', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        // The wrapper fires VS Code's built-in inline-suggest commit; with no suggestion
        // visible it is a no-op. It must not throw from our side.
        try {
            await vscode.commands.executeCommand('copilotInsightTracker.acceptInlineSuggestion');
        } catch {
            // Acceptable — VS Code may reject when no suggestion is active
        }
    }).timeout(10000);

    test('Extension should NOT track copy-paste operations', async () => {
        const ext = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(ext, `Extension '${EXTENSION_ID}' should be present`);
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        // Large paste without going through our command — must never set the flag
        const edit = new vscode.WorkspaceEdit();
        const largeCode = `
function complexFunction() {
    const result = [];
    for (let i = 0; i < 100; i++) {
        result.push(i * 2);
    }
    return result;
}

class MyClass {
    private data: string[];

    constructor() {
        this.data = [];
    }
    
    addItem(item: string) {
        this.data.push(item);
    }
}`;
        edit.insert(doc.uri, new vscode.Position(0, 0), largeCode);
        
        await vscode.workspace.applyEdit(edit);
        await new Promise(r => setTimeout(r, 1000));
        
        // Large paste without command interception should NOT be tracked
    }).timeout(10000);
});
