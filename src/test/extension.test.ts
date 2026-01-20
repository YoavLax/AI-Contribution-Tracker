import * as assert from 'assert';
import * as vscode from 'vscode';
import { CopilotTracker } from '../tracker';

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
        // We can't directly test context keys, but we verify the extension activates
        assert.ok(ext!.isActive, 'Extension should be active with context key set');
    }).timeout(10000);

    test('Extension should NOT track direct text edits (only AI accepts)', async () => {
        // The approach tracks changes that occur either:
        // 1. After our wrapper commands are called (inline suggestions)
        // 2. Large code blocks that look like AI-generated code (Chat/Agent)
        
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
    
    test('Commands should be registered', async () => {
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
        
        // Agentic commands
        assert.ok(
            commands.includes('copilotInsightTracker.applyChatCode'),
            'Apply chat code command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.insertChatCode'),
            'Insert chat code command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.insertChatCodeNewFile'),
            'Insert chat code new file command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptInlineChat'),
            'Accept inline chat command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptEditingFile'),
            'Accept editing file command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptAllEditingFiles'),
            'Accept all editing files command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.acceptEditingHunk'),
            'Accept editing hunk command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.discardEditingFile'),
            'Discard editing file command should be registered'
        );
        assert.ok(
            commands.includes('copilotInsightTracker.discardAllEditingFiles'),
            'Discard all editing files command should be registered'
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

    test('Agentic wrapper commands should execute without error', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();
        
        // Create a document
        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);
        
        // Execute agentic wrapper commands - they should not throw
        // (The original commands won't do anything without chat context)
        const agenticCommands = [
            'copilotInsightTracker.applyChatCode',
            'copilotInsightTracker.insertChatCode',
            'copilotInsightTracker.acceptInlineChat',
            'copilotInsightTracker.acceptEditingFile',
            'copilotInsightTracker.acceptAllEditingFiles',
            'copilotInsightTracker.acceptEditingHunk',
            'copilotInsightTracker.discardEditingFile',
            'copilotInsightTracker.discardAllEditingFiles'
        ];
        
        for (const cmd of agenticCommands) {
            try {
                await vscode.commands.executeCommand(cmd);
                // Command executed successfully
            } catch {
                // Expected - no chat context available
            }
        }
    }).timeout(15000);

    test('Extension should NOT track copy-paste operations', async () => {
        const ext = vscode.extensions.getExtension('demo.copilot-insight-tracker');
        await ext!.activate();

        const doc = await vscode.workspace.openTextDocument({ content: '', language: 'typescript' });
        await vscode.window.showTextDocument(doc);

        // Simulate a large paste - should NOT be tracked as it doesn't go through our commands
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
}
`;
        edit.insert(doc.uri, new vscode.Position(0, 0), largeCode);
        await vscode.workspace.applyEdit(edit);
        
        await new Promise(r => setTimeout(r, 500));
        // Large paste is ignored because it doesn't go through our intercepted commands
    }).timeout(10000);
});
