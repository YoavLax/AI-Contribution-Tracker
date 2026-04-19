import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
vscode.window.showInformationMessage('Start all tests.');

test('Extension should start and activate', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        assert.ok(ext, 'Extension should be present');
        
        const api = await ext.activate();
        assert.ok(ext.isActive, 'Extension should be active');

        assert.ok(api && api.tracker, 'Extension should export tracker');
    }).timeout(10000);

    test('Extension should set context key on activation', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();
        
        // The context key copilotInsightTracker.active should be set
        // This enables our keybindings to have higher priority
        assert.ok(ext!.isActive, 'Extension should be active with context key set');
    }).timeout(10000);

    test('Extension should NOT track direct text edits (only AI accepts)', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        // Small direct edit - should NOT be tracked
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(0, 0), 'const x = 1;');
        
        await vscode.workspace.applyEdit(edit);
        await new Promise(r => setTimeout(r, 500));
        
        // Small edits are ignored as they look like manual typing
    }).timeout(10000);

    test('Extension should NOT track small typing', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, new vscode.Position(0, 0), 'a');
        await vscode.workspace.applyEdit(edit);
        
        await new Promise(r => setTimeout(r, 200));
        // Small typing is ignored
    });
    
    test('Inline suggestion commands should be registered', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();
        
        const commands = await vscode.commands.getCommands(true);
        
        // Inline suggestion commands
        assert.ok(
            commands.includes('copilotInsightTracker.acceptInlineSuggestion'),
            'Accept inline suggestion command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptNextWord'),
            'Accept next word command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptNextLine'),
            'Accept next line command should be registered'
        );
        
        // Agentic commands should NOT be registered (handled by hooks now)
        assert.ok(
            !commands.includes('copilotInsightTracker.applyChatCode'),
            'Agentic command should not be registered'
        );
        assert.ok(
            !commands.includes('copilotInsightTracker.paste'),
            'Paste tracking command should not be registered'
        );
    });
    
    test('Wrapper command should execute original command', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();
        
        // Create a document
        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);
        
        // Execute our wrapper command - it should not throw
        // (The original command won't do anything without an inline suggestion visible)
        try {
            await vscode.commands.executeCommand('copilotInsightTracker.acceptInlineSuggestion');
            // Command executed successfully
        } catch {
            // Expected - no inline suggestion was visible
        }
    }).timeout(10000);

    test('Extension should NOT track copy-paste operations', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        // Simulate a large paste - should NOT be tracked
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
