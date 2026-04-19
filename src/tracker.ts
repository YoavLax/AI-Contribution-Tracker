import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// Minimal Git API definition
interface GitAPI {
    repositories: Repository[];
    getRepository(uri: vscode.Uri): Repository | null;
}

interface RepositoryState {
    HEAD?: { commit?: string };
    onDidChange: vscode.Event<void>;
}

interface Repository {
    rootUri: vscode.Uri;
    state: RepositoryState;
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
    source: 'ai_inline_accepted';
}

/**
 * VS Code inline suggestion commands
 */
const INLINE_SUGGEST_COMMIT = 'editor.action.inlineSuggest.commit';
const INLINE_SUGGEST_ACCEPT_WORD = 'editor.action.inlineSuggest.acceptNextWord';
const INLINE_SUGGEST_ACCEPT_LINE = 'editor.action.inlineSuggest.acceptNextLine';

export class CopilotTracker implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private logger: vscode.OutputChannel;
    private gitAPI: GitAPI | null = null;
    
    // Track pending AI acceptance - DETERMINISTIC: only set by our intercepted commands
    private _pendingAIAccept: boolean = false;
    private _pendingAcceptType: 'inline-full' | 'inline-word' | 'inline-line' = 'inline-full';
    private _preAcceptUri: string = '';
    
    constructor(logger: vscode.OutputChannel, gitAPI?: GitAPI) {
        this.logger = logger;
        this.gitAPI = gitAPI || null;
        
        // Set up DETERMINISTIC detection for inline suggestions
        this.setupDeterministicDetection();
        
        // Set up commit monitoring to log results
        this.setupCommitMonitoring();
        
        this.logger.appendLine('[Tracker] Initialized');
        this.logger.appendLine('[Tracker] Tracking: Inline suggestions (Tab/Ctrl+Right) - DETERMINISTIC');
        this.logger.appendLine('[Tracker] Tracking: Agent sessions via Copilot Hooks - DETERMINISTIC');
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
        
        // 2. Listen to document changes to confirm the result of intercepted commands
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
            setTimeout(() => {
                if (this._pendingAIAccept) {
                    this.logger.appendLine('[Tracker] Timeout: No document change detected');
                    this._pendingAIAccept = false;
                }
            }, 5000);
        }
    }

    /**
     * Monitor for commits to log the final AI impact result
     */
    private setupCommitMonitoring(): void {
        if (!this.gitAPI) {
            return;
        }
        
        // Track HEAD for each repository to detect commits
        const repoHeads = new Map<string, string>();
        
        for (const repo of this.gitAPI.repositories) {
            // Initialize HEAD tracking
            repoHeads.set(repo.rootUri.fsPath, repo.state.HEAD?.commit || '');
            
            // Watch for state changes
            this.disposables.push(
                repo.state.onDidChange(() => {
                    const repoPath = repo.rootUri.fsPath;
                    const currentHead = repo.state.HEAD?.commit || '';
                    const previousHead = repoHeads.get(repoPath) || '';
                    
                    // HEAD changed = new commit
                    if (currentHead && currentHead !== previousHead) {
                        repoHeads.set(repoPath, currentHead);
                        this.logCommitResult(repoPath);
                    }
                })
            );
        }
        
        this.logger.appendLine('[Tracker] Commit monitoring enabled');
    }
    
    /**
     * Log the result of AI impact detection when a commit occurs
     */
    private logCommitResult(repoPath: string): void {
        const gitDir = path.join(repoPath, '.git');
        const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
        
        if (!fs.existsSync(flagFile)) {
            this.logger.appendLine(`[Tracker] COMMIT DETECTED in ${path.basename(repoPath)} (flag consumed - AI impact added)`);
        } else {
            const flagContent = fs.readFileSync(flagFile, 'utf8').trim();
            this.logger.appendLine(`[Tracker] ════════════════════════════════════════════`);
            this.logger.appendLine(`[Tracker] COMMIT DETECTED in ${path.basename(repoPath)}`);
            this.logger.appendLine(`[Tracker] ⚠ AI Impact flag exists but wasn't consumed`);
            this.logger.appendLine(`[Tracker]   Flag content: ${flagContent}`);
            this.logger.appendLine(`[Tracker]   (Hook may not have run correctly)`);
            this.logger.appendLine(`[Tracker] ════════════════════════════════════════════`);
        }
    }

    /**
     * Document change handler - DETERMINISTIC detection only
     * 
     * We track edits in one scenario:
     * 1. Our intercepted inline accept command set _pendingAIAccept = true
     */
    public async onDocumentChange(event: vscode.TextDocumentChangeEvent): Promise<void> {
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
                this.logger.appendLine(`[Tracker] ✓ AI CONFIRMED (${acceptType}): ${charCount} chars, ${lineCount} lines`);
                this.logger.appendLine(`[Tracker] Content: "${text.substring(0, 60).replace(/\n/g, '\\n')}${text.length > 60 ? '...' : ''}"`);
                
                await this.markGitCommit(event.document.uri);

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

    /**
     * Mark git commit for inline suggestion acceptance.
     * Writes "Impacted by AI (Inline)" to the flag file.
     * If a flag already exists from Copilot hooks (agent session), merges them.
     */
    private async markGitCommit(uri: vscode.Uri): Promise<void> {
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
                
                if (fs.existsSync(gitDir)) {
                    const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
                    let finalMarker = 'Impacted by AI (Inline)';
                    
                    // Check for existing flag from hooks (agent session data)
                    if (fs.existsSync(flagFile)) {
                        const existing = fs.readFileSync(flagFile, 'utf8').trim();
                        
                        if (existing.includes('Inline')) {
                            // Already has inline marker, keep as-is
                            finalMarker = existing;
                        } else if (existing.startsWith('Impacted by AI')) {
                            // Has agent data from hooks — merge with Inline
                            // Extract the parenthetical content
                            const parenMatch = existing.match(/\((.+)\)$/);
                            if (parenMatch) {
                                finalMarker = `Impacted by AI (Inline + ${parenMatch[1]})`;
                            } else {
                                finalMarker = 'Impacted by AI (Inline)';
                            }
                        }
                    }
                    
                    fs.writeFileSync(flagFile, finalMarker);
                    this.logger.appendLine(`[Tracker] ✓ Git flag set: ${finalMarker}`);
                }
            } else {
                this.logger.appendLine(`[Tracker] No Git repo for: ${uri.fsPath}`);
            }
        } catch (error) {
            this.logger.appendLine(`[Tracker] Git error: ${error}`);
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
