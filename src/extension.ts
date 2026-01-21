// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { CopilotTracker } from './tracker';
import * as fs from 'fs';
import * as path from 'path';

// Create a global output channel
export const logger = vscode.window.createOutputChannel("AI Tracker Debug");

// Minimal Git API definition
interface GitAPI {
    repositories: Repository[];
}
interface Repository {
    rootUri: vscode.Uri;
}
interface GitExtension {
    getAPI(version: number): GitAPI;
}

export function activate(context: vscode.ExtensionContext) {
    logger.appendLine('ACTIVATE: Extension is starting...');
	console.log('ACTIVATE: Extension is starting (console)...');
    
    // Install or update the commit-msg hook
    // Moved to tracker.ts to ensure it runs for the relevant repo when needed
    
    let tracker: CopilotTracker | undefined;

    try {
        tracker = new CopilotTracker(logger);
        context.subscriptions.push(tracker);
        logger.appendLine('ACTIVATE: Tracker initialized.');
    } catch (e) {
        logger.appendLine(`ERROR: Failed to init tracker: ${e}`);
        console.error(e);
    }

	const disposable = vscode.commands.registerCommand('copilot-insight-tracker.helloWorld', () => {
		vscode.window.showInformationMessage('Copilot Insight Tracker is running.');
        logger.appendLine('COMMAND: Hello World triggered');
    });

	context.subscriptions.push(disposable);
    
    // Log configuration
    const config = vscode.workspace.getConfiguration('copilotInsightTracker');
    logger.appendLine(`CONFIG: agenticConfidenceThreshold=${config.get('agenticConfidenceThreshold')}`);
    
    return { tracker };
}

// Remove installGitHook function since it's moved to tracker
export function deactivate() {
    logger.appendLine('DEACTIVATE: Extension stopping...');
}
