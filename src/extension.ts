import * as vscode from 'vscode';
import { CopilotTracker } from './tracker';
import { CommitHookManager } from './commitHookManager';

export const logger = vscode.window.createOutputChannel("AI Tracker Debug");

export function activate(context: vscode.ExtensionContext) {
    logger.appendLine('ACTIVATE: Extension is starting...');

    const hookManager = new CommitHookManager(logger, context.globalState);
    hookManager.migrateFromLegacyGlobalSetup(context);
    hookManager.installForWorkspace();
    context.subscriptions.push(hookManager);

    let tracker: CopilotTracker | undefined;
    try {
        tracker = new CopilotTracker(logger);
        context.subscriptions.push(tracker);
        logger.appendLine('ACTIVATE: Tracker initialized.');
    } catch (e) {
        logger.appendLine(`ERROR: Failed to init tracker: ${e}`);
        console.error(e);
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('copilot-insight-tracker.helloWorld', () => {
            vscode.window.showInformationMessage('Copilot Insight Tracker is running.');
            logger.appendLine('COMMAND: Hello World triggered');
        })
    );

    const config = vscode.workspace.getConfiguration('copilotInsightTracker');
    logger.appendLine(`CONFIG: agenticConfidenceThreshold=${config.get('agenticConfidenceThreshold')}`);

    return { tracker };
}

export function deactivate() {
    logger.appendLine('DEACTIVATE: Extension stopping...');
    // CommitHookManager.dispose() is called automatically via context.subscriptions
}

