import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Minimal Git API definition
interface GitAPI {
    repositories: Repository[];
    getRepository(uri: vscode.Uri): Repository | null;
}

interface Repository {
    rootUri: vscode.Uri;
}

interface GitExtension {
    getAPI(version: number): GitAPI;
}

export interface CodeEvent {
    timestamp: number;
    fileName: string;
    languageId: string;
    changeType: 'insertion' | 'deletion' | 'replacement';
    charCount: number;
    lineCount: number;
    source: 'ai_inline_accepted' | 'ai_chat_applied';
}

/**
 * VS Code inline suggestion commands
 */
const INLINE_SUGGEST_COMMIT = 'editor.action.inlineSuggest.commit';
const INLINE_SUGGEST_ACCEPT_WORD = 'editor.action.inlineSuggest.acceptNextWord';
const INLINE_SUGGEST_ACCEPT_LINE = 'editor.action.inlineSuggest.acceptNextLine';

export class CopilotTracker implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private captureMode: boolean = true;
    private logger: vscode.OutputChannel;
    private gitAPI: GitAPI | null = null;
    
    // Track pending AI acceptance - DETERMINISTIC: only set by our intercepted commands
    private _pendingAIAccept: boolean = false;
    private _pendingAcceptType: 'inline-full' | 'inline-word' | 'inline-line' = 'inline-full';
    private _preAcceptUri: string = '';
    
    constructor(logger: vscode.OutputChannel, gitAPI?: GitAPI) {
        this.logger = logger;
        this.gitAPI = gitAPI || null;
        this.updateConfiguration();
        
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('copilotInsightTracker.captureMode')) {
                    this.updateConfiguration();
                }
            })
        );
        
        // Set up DETERMINISTIC detection only
        this.setupDeterministicDetection();
        
        this.logger.appendLine('[Tracker] Initialized - DETERMINISTIC mode only');
        this.logger.appendLine('[Tracker] Tracking: Inline suggestions (Tab/Ctrl+Right)');
        this.logger.appendLine('[Tracker] Ignoring: Paste, manual typing, chat/agent panel clicks (system limitation), all other edits');
    }
    
    /**
     * Update/Set Git API (useful for testing)
     */
    public setGitAPI(gitAPI: GitAPI): void {
        this.gitAPI = gitAPI;
        this.logger.appendLine('[Tracker] Git API updated via setGitAPI');
    }

    /**
     * Set up 100% deterministic AI detection via command interception
     */
    private setupDeterministicDetection(): void {
        // Enable our context key for keybinding priority
        vscode.commands.executeCommand('setContext', 'copilotInsightTracker.active', true);
        
        // 1. Register inline suggestion interceptors (DETERMINISTIC)
        this.registerInlineInterceptors();
        
        // 2. Listen to document changes to confirm the result of interrupted commands
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(this.onDocumentChange, this)
        );
    }
    
    /**
     * Register interceptors for inline suggestion accept commands
     */
    private registerInlineInterceptors(): void {
        // Tab - Full accept
        this.disposables.push(
            vscode.commands.registerCommand('copilotInsightTracker.acceptInlineSuggestion', async () => {
                this.logger.appendLine('[Tracker] ▶ INLINE ACCEPT (Tab) intercepted');
                await this.handleAccept('inline-full', INLINE_SUGGEST_COMMIT);
            })
        );
        
        // Ctrl+Right - Accept next word
        this.disposables.push(
            vscode.commands.registerCommand('copilotInsightTracker.acceptNextWord', async () => {
                this.logger.appendLine('[Tracker] ▶ INLINE ACCEPT (Word) intercepted');
                await this.handleAccept('inline-word', INLINE_SUGGEST_ACCEPT_WORD);
            })
        );
        
        // Accept next line
        this.disposables.push(
            vscode.commands.registerCommand('copilotInsightTracker.acceptNextLine', async () => {
                this.logger.appendLine('[Tracker] ▶ INLINE ACCEPT (Line) intercepted');
                await this.handleAccept('inline-line', INLINE_SUGGEST_ACCEPT_LINE);
            })
        );
        
        this.logger.appendLine('[Tracker] Inline suggestion interceptors registered');
    }

    /**
     * For testing purposes
     */
    public registerTestCommands(): void {
        this.disposables.push(
            vscode.commands.registerCommand('copilotInsightTracker.testTrigger', async () => {
                this.logger.appendLine('[Tracker] ▶ TEST TRIGGER intercepted');
                await this.handleAccept('inline-full', 'copilot-insight-tracker.test.noop');
            })
        );
        this.disposables.push(
            vscode.commands.registerCommand('copilot-insight-tracker.test.noop', async () => {
                // Do nothing
            })
        );
    }
    
    /**
     * Handle an AI accept command - sets flag before executing original command
     */
    private async handleAccept(
        acceptType: 'inline-full' | 'inline-word' | 'inline-line',
        originalCommand: string,
        args: unknown[] = []
    ): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        
        if (editor) {
            // Set the DETERMINISTIC flag
            this._pendingAIAccept = true;
            this._pendingAcceptType = acceptType;
            this._preAcceptUri = editor.document.uri.toString();
            
            this.logger.appendLine(`[Tracker] Flag set: pendingAIAccept=true, type=${acceptType}`);
        }
        
        try {
            // Execute the original VS Code command
            await vscode.commands.executeCommand(originalCommand, ...args);
        } catch (error) {
            this.logger.appendLine(`[Tracker] Command error (may be expected): ${error}`);
        } finally {
            // Reset after delay if no document change detected
            // Increased to 5s to account for slow applications or complex diffs
            setTimeout(() => {
                if (this._pendingAIAccept) {
                    this.logger.appendLine('[Tracker] Timeout: No document change detected');
                    this._pendingAIAccept = false;
                }
            }, 5000);
        }
    }

    private updateConfiguration(): void {
        const config = vscode.workspace.getConfiguration('copilotInsightTracker');
        this.captureMode = config.get<boolean>('captureMode', true);
        this.logger.appendLine(`[Tracker] Config: captureMode=${this.captureMode}`);
    }

    /**
     * Document change handler - DETERMINISTIC detection only
     * 
     * We track edits in one scenario:
     * 1. Our intercepted inline accept command set _pendingAIAccept = true
     */
    public async onDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
        if (!this.captureMode) {
            return;
        }

        // Skip undo/redo
        if (event.reason === vscode.TextDocumentChangeReason.Undo || 
            event.reason === vscode.TextDocumentChangeReason.Redo) {
            return;
        }

        if (event.contentChanges.length === 0) {
            return;
        }

        // DETERMINISTIC CHECK: Our intercepted inline accept command
        if (this._pendingAIAccept) {
            const currentUri = event.document.uri.toString();
            // Normalization: on Windows, allow c: vs C: mismatch
            // Also allow encoded colons
            const matches = this._preAcceptUri.toLowerCase() === currentUri.toLowerCase() ||
                            decodeURIComponent(this._preAcceptUri).toLowerCase() === decodeURIComponent(currentUri).toLowerCase();

            if (matches) {
                const processed = await this.processConfirmedAIChange(event, this._pendingAcceptType);
                if (processed) {
                    this._pendingAIAccept = false;
                }
                return;
            }
        }
    }
    
    /**
     * Process a confirmed AI change (from intercepted command)
     */
    private async processConfirmedAIChange(
        event: vscode.TextDocumentChangeEvent,
        acceptType: 'inline-full' | 'inline-word' | 'inline-line'
    ): Promise<boolean> {
        let confirmed = false;
        for (const change of event.contentChanges) {
            const text = change.text;
            const charCount = text.length;
            const lineCount = text.split('\n').length;

            if (charCount > 0) {
                const marker = acceptType === 'inline-full'
                        ? "Impacted by AI"
                        : `Impacted by AI - Partial (${acceptType.replace('inline-', '')})`;

                this.logger.appendLine(`[Tracker] ✓ AI CONFIRMED (${acceptType}): ${charCount} chars, ${lineCount} lines`);
                this.logger.appendLine(`[Tracker] Content: "${text.substring(0, 60).replace(/\n/g, '\\n')}${text.length > 60 ? '...' : ''}"`);
                
                await this.markGitCommit(event.document.uri, marker);

                this.logEvent({
                    timestamp: Date.now(),
                    fileName: event.document.fileName,
                    languageId: event.document.languageId,
                    changeType: change.rangeLength === 0 ? 'insertion' : 'replacement',
                    charCount,
                    lineCount,
                    source: 'ai_inline_accepted'
                });
                confirmed = true;
            }
        }
        return confirmed;
    }

    private async markGitCommit(uri: vscode.Uri, marker: string = "Impacted by AI"): Promise<void> {
        try {
            let git: GitAPI;

            if (this.gitAPI) {
                git = this.gitAPI;
            } else {
                const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
                if (!gitExtension) {
                    this.logger.appendLine('[Tracker] Git extension not found');
                    return;
                }
                git = gitExtension.exports.getAPI(1);
            }

            let repo = git.getRepository(uri);
            if (!repo) {
                repo = git.repositories.find(r => 
                    uri.fsPath.toLowerCase().startsWith(r.rootUri.fsPath.toLowerCase())
                ) || null;
            }

            if (repo) {
                const gitDir = path.join(repo.rootUri.fsPath, '.git');
                this.ensureGitHook(repo.rootUri.fsPath, gitDir);
                
                if (fs.existsSync(gitDir)) {
                    const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
                    fs.writeFileSync(flagFile, marker);
                    this.logger.appendLine(`[Tracker] ✓ Git flag set: ${marker}`);
                }
            } else {
                this.logger.appendLine(`[Tracker] No Git repo for: ${uri.fsPath}`);
            }
        } catch (error) {
            this.logger.appendLine(`[Tracker] Git error: ${error}`);
        }
    }

    private ensureGitHook(repoPath: string, gitDir: string): void {
        try {
            const hooksDir = path.join(gitDir, 'hooks');
            const hookFile = path.join(hooksDir, 'commit-msg');

            if (!fs.existsSync(gitDir)) {
                return;
            }
            if (!fs.existsSync(hooksDir)) {
                fs.mkdirSync(hooksDir);
            }

            const hookContent = `#!/bin/sh
# Auto-generated by Copilot Insight Tracker

IMPACT_FLAG=$(git rev-parse --git-path AI_IMPACT_PENDING)

if [ -f "$IMPACT_FLAG" ]; then
    MARKER=$(cat "$IMPACT_FLAG")
    if [ -z "$MARKER" ]; then
        MARKER="Impacted by AI"
    fi
    if ! grep -q "$MARKER" "$1"; then
        echo "" >> "$1"
        echo "$MARKER" >> "$1"
    fi
    rm "$IMPACT_FLAG"
fi
`.replace(/\r\n/g, '\n');

            if (!fs.existsSync(hookFile)) {
                fs.writeFileSync(hookFile, hookContent);
                fs.chmodSync(hookFile, '755');
                this.logger.appendLine(`[Tracker] Installed git hook in ${repoPath}`);
            } else {
                const currentContent = fs.readFileSync(hookFile, 'utf8');
                if (!currentContent.includes('AI_IMPACT_PENDING')) {
                    const prefix = currentContent.endsWith('\n') ? '' : '\n';
                    fs.writeFileSync(hookFile, currentContent + prefix + hookContent);
                    this.logger.appendLine(`[Tracker] Updated git hook in ${repoPath}`);
                }
            }
        } catch (e) {
            this.logger.appendLine(`[Tracker] Hook error: ${e}`);
        }
    }

    private logEvent(event: CodeEvent): void {
        this.logger.appendLine(`[Tracker] Event: ${JSON.stringify(event)}`);
    }

    dispose(): void {
        vscode.commands.executeCommand('setContext', 'copilotInsightTracker.active', false);
        this.disposables.forEach(d => d.dispose());
    }
}
