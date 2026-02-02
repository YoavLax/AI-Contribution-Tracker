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
    source: 'ai_inline_accepted' | 'ai_chat_applied' | 'ai_chat_apply' | 'ai_chat_insert' | 'ai_inline_chat_accepted' | 'ai_editing_session_accepted';
}

/**
 * VS Code inline suggestion commands
 */
const INLINE_SUGGEST_COMMIT = 'editor.action.inlineSuggest.commit';
const INLINE_SUGGEST_ACCEPT_WORD = 'editor.action.inlineSuggest.acceptNextWord';
const INLINE_SUGGEST_ACCEPT_LINE = 'editor.action.inlineSuggest.acceptNextLine';

/**
 * VS Code Chat/Agentic commands
 */
const CHAT_APPLY_IN_EDITOR = 'workbench.action.chat.applyInEditor';
const CHAT_INSERT_CODE_BLOCK = 'workbench.action.chat.insertCodeBlock';
const CHAT_INSERT_INTO_NEW_FILE = 'workbench.action.chat.insertIntoNewFile';
const INLINE_CHAT_ACCEPT = 'inlineChat.acceptChanges';
const CHAT_EDITING_ACCEPT_FILE = 'chatEditing.acceptFile';
const CHAT_EDITING_ACCEPT_ALL = 'chatEditing.acceptAllFiles';
const CHAT_EDITING_ACCEPT_HUNK = 'chatEditing.acceptHunk';
const CHAT_EDITING_DISCARD_FILE = 'chatEditing.discardFile';
const CHAT_EDITING_DISCARD_ALL = 'chatEditing.discardAllFiles';

export class CopilotTracker implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private agenticConfidenceThreshold: number = 70;
    private logger: vscode.OutputChannel;
    private gitAPI: GitAPI | null = null;
    
    // Track pending AI acceptance - DETERMINISTIC: only set by our intercepted commands
    private _pendingAIAccept: boolean = false;
    private _pendingAcceptType: 'inline-full' | 'inline-word' | 'inline-line' = 'inline-full';
    private _preAcceptUri: string = '';
    
    // Track pending Agentic AI acceptance
    private _pendingAgenticAccept: boolean = false;
    private _pendingAgenticType: 'chat_apply' | 'chat_insert' | 'chat_insert_new_file' | 'inline_chat' | 'editing_session' | 'editing_hunk' = 'chat_apply';
    
    // Track editing session state
    private _editingSessionActive: boolean = false;
    private _affectedRepositories: Set<string> = new Set();
    
    // Confidence-based agentic detection state
    private _recentChanges: { uri: string; time: number; chars: number; isBackground: boolean }[] = [];
    private _lastTypingTime: number = 0;
    private _lastPasteTime: number = 0;
    private _highestConfidenceScore: number = 0;
    
    constructor(logger: vscode.OutputChannel, gitAPI?: GitAPI) {
        this.logger = logger;
        this.gitAPI = gitAPI || null;
        this.updateConfiguration();
        
        this.disposables.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('copilotInsightTracker.agenticConfidenceThreshold')) {
                    this.updateConfiguration();
                }
            })
        );
        
        // Set up DETERMINISTIC detection only
        this.setupDeterministicDetection();
        
        // Set up file creation/rename listeners for editing sessions
        this.setupFileListeners();
        
        // Set up commit monitoring to log results
        this.setupCommitMonitoring();
        
        this.logger.appendLine('[Tracker] Initialized');
        this.logger.appendLine('[Tracker] Tracking: Inline suggestions (Tab/Ctrl+Right) - DETERMINISTIC');
        this.logger.appendLine('[Tracker] Tracking: Agentic edits (Chat Apply, Inline Chat, Agent Mode) - CONFIDENCE-BASED');
        this.logger.appendLine(`[Tracker] Agentic confidence threshold: ${this.agenticConfidenceThreshold}%`);
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
        
        // 2. Register agentic command interceptors (DETERMINISTIC)
        this.registerAgenticInterceptors();
        
        // 3. Listen to document changes to confirm the result of intercepted commands
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(this.onDocumentChange, this)
        );
        
        // 4. Start monitoring editing session context
        this.startEditingSessionMonitor();
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
     * Register interceptors for agentic AI commands (Chat Apply, Inline Chat, Agent Mode)
     * 
     * NOTE: We cannot directly intercept button clicks in Chat UI.
     * Instead, we:
     * 1. Register wrapper commands for keybinding support
     * 2. Use the editing session monitor to detect Agent Mode changes
     */
    private registerAgenticInterceptors(): void {
        // Register wrapper commands for keybinding support
        this.registerAgenticCommand(
            'copilotInsightTracker.applyChatCode',
            CHAT_APPLY_IN_EDITOR,
            'chat_apply',
            'CHAT APPLY IN EDITOR'
        );

        this.registerAgenticCommand(
            'copilotInsightTracker.insertChatCode',
            CHAT_INSERT_CODE_BLOCK,
            'chat_insert',
            'CHAT INSERT AT CURSOR'
        );

        this.registerAgenticCommand(
            'copilotInsightTracker.insertChatCodeNewFile',
            CHAT_INSERT_INTO_NEW_FILE,
            'chat_insert_new_file',
            'CHAT INSERT INTO NEW FILE'
        );

        this.registerAgenticCommand(
            'copilotInsightTracker.acceptInlineChat',
            INLINE_CHAT_ACCEPT,
            'inline_chat',
            'INLINE CHAT ACCEPT'
        );

        this.registerAgenticCommand(
            'copilotInsightTracker.acceptEditingFile',
            CHAT_EDITING_ACCEPT_FILE,
            'editing_session',
            'EDITING SESSION ACCEPT FILE'
        );

        this.registerAgenticCommand(
            'copilotInsightTracker.acceptAllEditingFiles',
            CHAT_EDITING_ACCEPT_ALL,
            'editing_session',
            'EDITING SESSION ACCEPT ALL'
        );

        this.registerAgenticCommand(
            'copilotInsightTracker.acceptEditingHunk',
            CHAT_EDITING_ACCEPT_HUNK,
            'editing_hunk',
            'EDITING SESSION ACCEPT HUNK'
        );

        this.registerDiscardCommand(
            'copilotInsightTracker.discardEditingFile',
            CHAT_EDITING_DISCARD_FILE,
            'EDITING SESSION DISCARD FILE'
        );

        this.registerDiscardCommand(
            'copilotInsightTracker.discardAllEditingFiles',
            CHAT_EDITING_DISCARD_ALL,
            'EDITING SESSION DISCARD ALL'
        );

        // Register paste tracking command
        this.registerPasteCommand();

        this.logger.appendLine('[Tracker] Agentic command interceptors registered');
        this.logger.appendLine('[Tracker] NOTE: Button clicks detected via editing session monitor');
    }

    /**
     * Helper to register an agentic accept command
     */
    private registerAgenticCommand(
        commandId: string,
        originalCommand: string,
        agenticType: 'chat_apply' | 'chat_insert' | 'chat_insert_new_file' | 'inline_chat' | 'editing_session' | 'editing_hunk',
        logLabel: string
    ): void {
        try {
            this.disposables.push(
                vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
                    this.logger.appendLine(`[Tracker] ▶ ${logLabel} intercepted`);
                    await this.handleAgenticAccept(agenticType, originalCommand, args);
                })
            );
        } catch (error) {
            this.logger.appendLine(`[Tracker] Could not register ${commandId}: ${error}`);
        }
    }

    /**
     * Helper to register a discard command (clears flags)
     */
    private registerDiscardCommand(
        commandId: string,
        originalCommand: string,
        logLabel: string
    ): void {
        try {
            this.disposables.push(
                vscode.commands.registerCommand(commandId, async (...args: unknown[]) => {
                    this.logger.appendLine(`[Tracker] ▶ ${logLabel} intercepted`);
                    
                    // Execute original command
                    try {
                        await vscode.commands.executeCommand(originalCommand, ...args);
                    } catch (error) {
                        this.logger.appendLine(`[Tracker] Command error: ${error}`);
                    }
                    
                    // Clear flags for affected repositories
                    await this.clearAgenticFlags();
                })
            );
        } catch (error) {
            this.logger.appendLine(`[Tracker] Could not register ${commandId}: ${error}`);
        }
    }

    /**
     * Register paste command wrapper to track paste operations
     * This allows us to distinguish user paste from AI insertions
     */
    private registerPasteCommand(): void {
        try {
            this.disposables.push(
                vscode.commands.registerCommand('copilotInsightTracker.paste', async (...args: unknown[]) => {
                    // Mark that paste is happening - this will be used as negative signal
                    this._lastPasteTime = Date.now();
                    this.logger.appendLine('[Tracker] ▶ PASTE intercepted');
                    
                    // Execute the original paste command
                    try {
                        await vscode.commands.executeCommand('editor.action.clipboardPasteAction', ...args);
                    } catch (error) {
                        this.logger.appendLine(`[Tracker] Paste error: ${error}`);
                    }
                })
            );
            this.logger.appendLine('[Tracker] Paste tracking command registered');
        } catch (error) {
            this.logger.appendLine(`[Tracker] Could not register paste command: ${error}`);
        }
    }

    /**
     * Set up file creation and rename listeners for editing session detection
     */
    private setupFileListeners(): void {
        // Listen for new file creation during editing sessions
        this.disposables.push(
            vscode.workspace.onDidCreateFiles(async (event) => {
                // File creation without user action is strong signal of agentic behavior
                // Score: Background creation (+30) + Pure creation (+15) = 45% base
                // Add multi-file bonus if applicable
                const now = Date.now();
                for (const file of event.files) {
                    let confidence = 45; // Base for file creation
                    
                    // Check for multi-file rapid changes
                    this._recentChanges.push({ uri: file.toString(), time: now, chars: 0, isBackground: true });
                    const uniqueFiles = new Set(this._recentChanges.map(c => c.uri)).size;
                    if (uniqueFiles >= 2) {
                        confidence += 25;
                    }
                    
                    // Check if window is unfocused
                    if (!vscode.window.state.focused) {
                        confidence += 35;
                    }
                    
                    confidence = Math.min(100, confidence);
                    
                    if (confidence >= this.agenticConfidenceThreshold) {
                        this.logger.appendLine(`[Tracker] ✓ AGENTIC FILE CREATED (${confidence}%): ${file.fsPath}`);
                        const marker = `Impacted by AI (Agentic - ${confidence}% confidence)`;
                        await this.markGitCommitWithConsolidation(file, marker, true);
                    } else {
                        this.logger.appendLine(`[Tracker] File created below threshold (${confidence}%): ${file.fsPath}`);
                    }
                }
            })
        );

        // Listen for file renames during editing sessions
        this.disposables.push(
            vscode.workspace.onDidRenameFiles(async (event) => {
                // File rename is a moderate signal of agentic behavior
                const now = Date.now();
                for (const { oldUri, newUri } of event.files) {
                    let confidence = 35; // Base for file rename
                    
                    // Check if window is unfocused
                    if (!vscode.window.state.focused) {
                        confidence += 35;
                    }
                    
                    // Check for multi-file rapid changes
                    this._recentChanges.push({ uri: newUri.toString(), time: now, chars: 0, isBackground: true });
                    const uniqueFiles = new Set(this._recentChanges.map(c => c.uri)).size;
                    if (uniqueFiles >= 2) {
                        confidence += 25;
                    }
                    
                    confidence = Math.min(100, confidence);
                    
                    if (confidence >= this.agenticConfidenceThreshold) {
                        this.logger.appendLine(`[Tracker] ✓ AGENTIC FILE RENAMED (${confidence}%): ${oldUri.fsPath} -> ${newUri.fsPath}`);
                        const marker = `Impacted by AI (Agentic - ${confidence}% confidence)`;
                        await this.markGitCommitWithConsolidation(newUri, marker, true);
                    } else {
                        this.logger.appendLine(`[Tracker] File renamed below threshold (${confidence}%): ${newUri.fsPath}`);
                    }
                }
            })
        );
    }

    /**
     * Monitor document changes for confidence-based agentic detection
     * 
     * Uses a multi-signal scoring system to detect AI-generated code insertions.
     * Only marks commits when confidence exceeds the configured threshold.
     */
    private startEditingSessionMonitor(): void {
        // Monitor text document changes for Agent Mode detection
        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument(async (event) => {
                // Skip if we're already handling an inline suggestion
                if (this._pendingAIAccept) {
                    return;
                }
                
                // Skip undo/redo
                if (event.reason === vscode.TextDocumentChangeReason.Undo ||
                    event.reason === vscode.TextDocumentChangeReason.Redo) {
                    return;
                }
                
                // Skip empty changes
                if (event.contentChanges.length === 0) {
                    return;
                }
                
                // Skip non-file schemes (git, output, etc.)
                if (event.document.uri.scheme !== 'file' && 
                    event.document.uri.scheme !== 'untitled') {
                    return;
                }
                
                const totalInserted = event.contentChanges.reduce((sum, c) => sum + c.text.length, 0);
                const totalDeleted = event.contentChanges.reduce((sum, c) => sum + c.rangeLength, 0);
                const totalChars = totalInserted + totalDeleted; // Consider both insertions AND deletions
                
                // DEBUG: Log every change we see
                this.logger.appendLine(`[Tracker] Document changed: ${event.document.fileName} (+${totalInserted}/-${totalDeleted} chars, scheme: ${event.document.uri.scheme})`);
                
                // Track typing activity (small changes < 5 chars are likely typing)
                if (totalChars < 5) {
                    this._lastTypingTime = Date.now();
                    return; // Don't evaluate very small changes
                }
                
                // Calculate confidence score for this change
                const confidence = this.calculateAgenticConfidence(event);
                
                // Update highest score for this session
                if (confidence > this._highestConfidenceScore) {
                    this._highestConfidenceScore = confidence;
                }
                
                // Only mark if confidence meets threshold
                if (confidence >= this.agenticConfidenceThreshold) {
                    this._editingSessionActive = true;
                    await this.handleAgenticChangeWithConfidence(event, confidence);
                } else {
                    this.logger.appendLine(`[Tracker] Below threshold (${confidence}% < ${this.agenticConfidenceThreshold}%): ${event.document.fileName}`);
                }
            })
        );
        
        // Periodically clean up old tracking data
        const cleanupInterval = setInterval(() => {
            const now = Date.now();
            // Clean up changes older than 10 seconds
            while (this._recentChanges.length > 0 && this._recentChanges[0].time < now - 10000) {
                this._recentChanges.shift();
            }
            // Reset highest confidence if no activity for 30 seconds
            if (this._recentChanges.length === 0 && this._highestConfidenceScore > 0) {
                this._highestConfidenceScore = 0;
                this._editingSessionActive = false;
            }
        }, 5000);

        this.disposables.push({
            dispose: () => {
                clearInterval(cleanupInterval);
                this._recentChanges.length = 0;
            }
        });
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
                        this.logCommitResult(repoPath, repo);
                    }
                })
            );
        }
        
        this.logger.appendLine('[Tracker] Commit monitoring enabled');
    }
    
    /**
     * Log the result of AI impact detection when a commit occurs
     */
    private logCommitResult(repoPath: string, repo: Repository): void {
        const gitDir = path.join(repoPath, '.git');
        const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
        
        // Check if flag was consumed (file no longer exists = hook ran)
        if (!fs.existsSync(flagFile)) {
            // Flag was consumed by hook - AI impact was added to commit
            if (this._highestConfidenceScore > 0) {
                this.logger.appendLine(`[Tracker] ════════════════════════════════════════════`);
                this.logger.appendLine(`[Tracker] COMMIT DETECTED in ${path.basename(repoPath)}`);
                this.logger.appendLine(`[Tracker] ✓ AI Impact ADDED to commit message`);
                this.logger.appendLine(`[Tracker]   Highest confidence score: ${this._highestConfidenceScore}%`);
                this.logger.appendLine(`[Tracker]   Threshold: ${this.agenticConfidenceThreshold}%`);
                this.logger.appendLine(`[Tracker] ════════════════════════════════════════════`);
            } else {
                this.logger.appendLine(`[Tracker] COMMIT DETECTED in ${path.basename(repoPath)} (no AI impact)`);
            }
        } else {
            // Flag still exists - either hook didn't run or threshold wasn't met
            const flagContent = fs.readFileSync(flagFile, 'utf8').trim();
            this.logger.appendLine(`[Tracker] ════════════════════════════════════════════`);
            this.logger.appendLine(`[Tracker] COMMIT DETECTED in ${path.basename(repoPath)}`);
            this.logger.appendLine(`[Tracker] ⚠ AI Impact flag exists but wasn't consumed`);
            this.logger.appendLine(`[Tracker]   Flag content: ${flagContent}`);
            this.logger.appendLine(`[Tracker]   (Hook may not have run correctly)`);
            this.logger.appendLine(`[Tracker] ════════════════════════════════════════════`);
        }
        
        // Reset highest confidence for next session
        this._highestConfidenceScore = 0;
        this._editingSessionActive = false;
        this._affectedRepositories.delete(repoPath);
    }
    
    /**
     * Calculate confidence score (0-100%) that a change is AI-generated
     * 
     * Scoring signals:
     * - VS Code window not focused: +35
     * - Background document change: +30
     * - Multi-file rapid changes: +25
     * - No recent typing in VS Code: +20
     * - Very fast insertion rate: +20
     * - Chat panel visible: +20
     * - Pure insertion (no deletions): +15
     * - Large code block (200+ chars): +15
     * - Markdown with formatted content: +10
     * - Code structure patterns: +10
     * - Complete statements: +5
     * - Recent paste operation: -50 (negative signal)
     */
    private calculateAgenticConfidence(event: vscode.TextDocumentChangeEvent): number {
        let score = 0;
        const scoreBreakdown: string[] = [];
        const now = Date.now();
        const docKey = event.document.uri.toString();
        const activeEditor = vscode.window.activeTextEditor;
        const isActiveDocument = activeEditor?.document.uri.toString() === docKey;
        const totalInserted = event.contentChanges.reduce((sum, c) => sum + c.text.length, 0);
        const totalText = event.contentChanges.map(c => c.text).join('');
        const totalDeletions = event.contentChanges.reduce((sum, c) => sum + c.rangeLength, 0);
        const totalChars = totalInserted + totalDeletions; // Total activity = insertions + deletions
        
        // Clean up old changes (keep last 5 seconds)
        while (this._recentChanges.length > 0 && this._recentChanges[0].time < now - 5000) {
            this._recentChanges.shift();
        }
        
        // Track this change (includes both insertions and deletions)
        this._recentChanges.push({ 
            uri: docKey, 
            time: now, 
            chars: totalChars, 
            isBackground: !isActiveDocument 
        });
        
        // --- NEGATIVE SIGNAL: Recent paste operation (-50) ---
        const timeSincePaste = now - this._lastPasteTime;
        if (timeSincePaste < 500) {
            score -= 50;
            scoreBreakdown.push(`-50: Recent paste (${timeSincePaste}ms ago)`);
        }
        
        // --- SIGNAL 1: VS Code window not focused (+35) ---
        const isVSCodeFocused = vscode.window.state.focused;
        if (!isVSCodeFocused && totalChars > 10) {
            score += 35;
            scoreBreakdown.push('+35: VS Code unfocused');
        }
        
        // --- SIGNAL 2: Background document change (+30) ---
        if (!isActiveDocument && totalChars > 10) {
            score += 30;
            scoreBreakdown.push('+30: Background doc change');
        }
        
        // --- SIGNAL 3: Multi-file rapid changes (+25) ---
        const uniqueFilesChanged = new Set(this._recentChanges.map(c => c.uri)).size;
        if (uniqueFilesChanged >= 2) {
            score += 25;
            scoreBreakdown.push(`+25: Multi-file (${uniqueFilesChanged} files)`);
        }
        
        // --- SIGNAL 4: No recent typing in VS Code (+20, or +40 for large insertions) ---
        const timeSinceTyping = now - this._lastTypingTime;
        if (timeSinceTyping > 2000 && totalChars > 20) {
            // Stronger signal for larger insertions without typing
            if (totalChars >= 100 && timeSinceTyping > 3000) {
                score += 40;
                scoreBreakdown.push(`+40: No typing + large insertion (${Math.round(timeSinceTyping/1000)}s gap, ${totalChars} chars)`);
            } else {
                score += 20;
                scoreBreakdown.push(`+20: No recent typing (${Math.round(timeSinceTyping/1000)}s gap)`);
            }
        }
        
        // --- SIGNAL 5: Very fast insertion rate (+20) ---
        const recentLargeChanges = this._recentChanges.filter(c => c.chars > 50 && c.time > now - 1000);
        if (recentLargeChanges.length > 0) {
            const totalRecentChars = recentLargeChanges.reduce((sum, c) => sum + c.chars, 0);
            if (totalRecentChars > 100) {
                score += 20;
                scoreBreakdown.push(`+20: Fast insertion (${totalRecentChars} chars/sec)`);
            }
        }
        
        // --- SIGNAL 6: Chat panel visible (+20) ---
        // Check for chat-related views (best effort detection)
        const visibleEditors = vscode.window.visibleTextEditors;
        const hasChatScheme = visibleEditors.some(e => 
            e.document.uri.scheme.includes('chat') || 
            e.document.uri.scheme.includes('copilot')
        );
        if (hasChatScheme) {
            score += 20;
            scoreBreakdown.push('+20: Chat panel visible');
        }
        
        // --- SIGNAL 7: Pure insertion - no deletions (+15) ---
        if (totalDeletions === 0 && totalInserted > 20) {
            score += 15;
            scoreBreakdown.push('+15: Pure insertion');
        }
        
        // --- SIGNAL 8: Large code block (+15) ---
        if (totalChars >= 200) {
            score += 15;
            scoreBreakdown.push(`+15: Large block (${totalChars} chars)`);
        } else if (totalChars >= 100) {
            score += 8;
            scoreBreakdown.push(`+8: Medium block (${totalChars} chars)`);
        }
        
        // --- SIGNAL 9: Markdown with formatted content (+10) ---
        const isMarkdown = event.document.languageId === 'markdown' || 
                          event.document.fileName.endsWith('.md');
        if (isMarkdown) {
            const hasFormatting = /^#{1,6}\s|^\s*[-*]\s|\*\*|```|^\s*>\s/m.test(totalText);
            if (hasFormatting && totalChars > 30) {
                score += 10;
                scoreBreakdown.push('+10: Markdown formatting');
            }
        }
        
        // --- SIGNAL 10: Code structure patterns (+10) ---
        const hasCodeStructure = /\b(function|class|const|let|var|import|export|interface|type|def |async |await |return |if |for |while )\b/.test(totalText);
        const hasMultipleStatements = (totalText.match(/[;{}]/g) || []).length >= 3;
        if (hasCodeStructure && hasMultipleStatements) {
            score += 10;
            scoreBreakdown.push('+10: Code structure');
        }
        
        // --- SIGNAL 11: Complete statements (+5) ---
        const lines = totalText.split('\n').filter(l => l.trim().length > 0);
        const completeLines = lines.filter(l => /[;{})\]:]$/.test(l.trim()));
        if (lines.length >= 3 && completeLines.length >= lines.length * 0.5) {
            score += 5;
            scoreBreakdown.push(`+5: Complete statements (${completeLines.length}/${lines.length})`);
        }
        
        // --- SIGNAL 12: Sustained background activity (+20 to +30) ---
        // If we have multiple consecutive background changes in the last 5 seconds, it's likely AI
        const recentBackgroundChanges = this._recentChanges.filter(c => c.isBackground && c.time > now - 5000);
        if (recentBackgroundChanges.length >= 3) {
            // Many consecutive background changes - strong AI indicator
            if (recentBackgroundChanges.length >= 6) {
                score += 30;
                scoreBreakdown.push(`+30: Sustained background activity (${recentBackgroundChanges.length} changes)`);
            } else {
                score += 20;
                scoreBreakdown.push(`+20: Multiple background changes (${recentBackgroundChanges.length} changes)`);
            }
        }
        
        // --- SIGNAL 13: Large deletion or replacement (+15) ---
        // AI often deletes/replaces large chunks at once
        if (totalDeletions > 50) {
            // Large deletion - possibly AI clearing or replacing content
            if (!isActiveDocument) {
                // Background deletion is very suspicious
                score += 25;
                scoreBreakdown.push(`+25: Large background deletion (${totalDeletions} chars deleted)`);
            } else if (timeSinceTyping > 2000) {
                // Active doc but no recent typing - still suspicious
                score += 15;
                scoreBreakdown.push(`+15: Large deletion without typing (${totalDeletions} chars deleted)`);
            }
        }
        
        // --- SIGNAL 14: Replacement operation in background (+15) ---
        // If both insertions and deletions happen in background, it's a replacement
        if (totalDeletions > 10 && totalChars > 10 && !isActiveDocument) {
            score += 15;
            scoreBreakdown.push(`+15: Background replacement (+${totalChars}/-${totalDeletions})`);
        }
        
        // Cap at 100
        score = Math.min(100, score);
        
        // Log breakdown for debugging
        if (scoreBreakdown.length > 0) {
            this.logger.appendLine(`[Scorer] ${event.document.fileName}: ${score}%`);
            scoreBreakdown.forEach(s => this.logger.appendLine(`[Scorer]   ${s}`));
        }
        
        return score;
    }
    
    /**
     * Handle an agentic change that passed the confidence threshold
     */
    private async handleAgenticChangeWithConfidence(
        event: vscode.TextDocumentChangeEvent, 
        confidence: number
    ): Promise<void> {
        const totalChars = event.contentChanges.reduce((sum, c) => sum + c.text.length, 0);
        
        this.logger.appendLine(`[Tracker] ✓ AGENTIC DETECTED (${confidence}%): ${totalChars} chars in ${event.document.fileName}`);
        
        const marker = `Impacted by AI (Agentic - ${confidence}% confidence)`;
        await this.markGitCommitWithConsolidation(event.document.uri, marker, true);
        
        this.logEvent({
            timestamp: Date.now(),
            fileName: event.document.fileName,
            languageId: event.document.languageId,
            changeType: 'insertion',
            charCount: totalChars,
            lineCount: event.contentChanges.reduce((sum, c) => sum + c.text.split('\n').length, 0),
            source: 'ai_editing_session_accepted'
        });
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

    /**
     * Handle an agentic AI accept command - marks commit directly
     * Unlike inline suggestions, agentic commands directly apply code,
     * so we mark the commit immediately after the command executes.
     */
    private async handleAgenticAccept(
        agenticType: 'chat_apply' | 'chat_insert' | 'chat_insert_new_file' | 'inline_chat' | 'editing_session' | 'editing_hunk',
        originalCommand: string,
        args: unknown[] = []
    ): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        
        // Mark editing session as active for file creation/rename detection
        if (agenticType === 'editing_session' || agenticType === 'editing_hunk') {
            this._editingSessionActive = true;
        }
        
        this._pendingAgenticAccept = true;
        this._pendingAgenticType = agenticType;
        
        this.logger.appendLine(`[Tracker] Flag set: pendingAgenticAccept=true, type=${agenticType}`);
        
        try {
            // Execute the original VS Code command
            await vscode.commands.executeCommand(originalCommand, ...args);
            
            // For agentic commands, the code is applied directly
            // We mark the commit based on the active editor or affected files
            if (editor) {
                await this.markGitCommitAgentic(editor.document.uri, agenticType);
            } else {
                // No active editor, try to mark based on workspace folders
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (workspaceFolders && workspaceFolders.length > 0) {
                    await this.markGitCommitAgentic(workspaceFolders[0].uri, agenticType);
                }
            }
            
            this.logEvent({
                timestamp: Date.now(),
                fileName: editor?.document.fileName || 'unknown',
                languageId: editor?.document.languageId || 'unknown',
                changeType: 'insertion',
                charCount: 0, // Unknown for agentic
                lineCount: 0, // Unknown for agentic
                source: this.getAgenticSource(agenticType)
            });
            
        } catch (error) {
            this.logger.appendLine(`[Tracker] Agentic command error: ${error}`);
        } finally {
            this._pendingAgenticAccept = false;
            
            // Keep editing session active until explicit discard
            if (agenticType !== 'editing_session' && agenticType !== 'editing_hunk') {
                // For non-editing-session commands, reset immediately
            }
        }
    }

    /**
     * Convert agentic type to CodeEvent source
     */
    private getAgenticSource(agenticType: string): 'ai_chat_apply' | 'ai_chat_insert' | 'ai_inline_chat_accepted' | 'ai_editing_session_accepted' {
        switch (agenticType) {
            case 'chat_apply':
                return 'ai_chat_apply';
            case 'chat_insert':
            case 'chat_insert_new_file':
                return 'ai_chat_insert';
            case 'inline_chat':
                return 'ai_inline_chat_accepted';
            case 'editing_session':
            case 'editing_hunk':
                return 'ai_editing_session_accepted';
            default:
                return 'ai_chat_apply';
        }
    }

    /**
     * Mark git commit for agentic changes with consolidation logic
     */
    private async markGitCommitAgentic(
        uri: vscode.Uri,
        agenticType: 'chat_apply' | 'chat_insert' | 'chat_insert_new_file' | 'inline_chat' | 'editing_session' | 'editing_hunk'
    ): Promise<void> {
        const marker = 'Impacted by AI (Agentic)';
        await this.markGitCommitWithConsolidation(uri, marker, true);
    }

    /**
     * Clear agentic flags from affected repositories (called on discard)
     */
    private async clearAgenticFlags(): Promise<void> {
        try {
            let git: GitAPI;

            if (this.gitAPI) {
                git = this.gitAPI;
            } else {
                const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
                if (!gitExtension) {
                    return;
                }
                git = gitExtension.exports.getAPI(1);
            }

            // Clear flags from all tracked repositories
            for (const repoPath of this._affectedRepositories) {
                const flagFile = path.join(repoPath, '.git', 'AI_IMPACT_PENDING');
                if (fs.existsSync(flagFile)) {
                    const content = fs.readFileSync(flagFile, 'utf8');
                    
                    // If it's a combined marker, revert to inline only
                    if (content.includes('Inline + Agentic')) {
                        fs.writeFileSync(flagFile, 'Impacted by AI');
                        this.logger.appendLine(`[Tracker] Reverted flag to inline-only: ${repoPath}`);
                    } else if (content.includes('Agentic')) {
                        // Pure agentic, remove entirely
                        fs.unlinkSync(flagFile);
                        this.logger.appendLine(`[Tracker] Cleared agentic flag: ${repoPath}`);
                    }
                }
            }
            
            this._affectedRepositories.clear();
            this._editingSessionActive = false;
            
        } catch (error) {
            this.logger.appendLine(`[Tracker] Error clearing flags: ${error}`);
        }
    }

    private updateConfiguration(): void {
        const config = vscode.workspace.getConfiguration('copilotInsightTracker');
        this.agenticConfidenceThreshold = config.get<number>('agenticConfidenceThreshold', 70);
        this.logger.appendLine(`[Tracker] Config: threshold=${this.agenticConfidenceThreshold}%`);
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
        await this.markGitCommitWithConsolidation(uri, marker, false);
    }

    /**
     * Mark git commit with consolidation logic for inline + agentic markers
     */
    private async markGitCommitWithConsolidation(
        uri: vscode.Uri,
        marker: string,
        isAgentic: boolean
    ): Promise<void> {
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
                // Note: Git hooks are now installed globally by extension.ts on activation
                
                if (fs.existsSync(gitDir)) {
                    const flagFile = path.join(gitDir, 'AI_IMPACT_PENDING');
                    let finalMarker = marker;
                    
                    // Check for existing flag and consolidate
                    if (fs.existsSync(flagFile)) {
                        const existingMarker = fs.readFileSync(flagFile, 'utf8').trim();
                        
                        // Extract existing confidence if present
                        const existingConfidenceMatch = existingMarker.match(/(\d+)%\s*confidence/);
                        const existingConfidence = existingConfidenceMatch ? parseInt(existingConfidenceMatch[1], 10) : 0;
                        
                        // Extract new confidence if present
                        const newConfidenceMatch = marker.match(/(\d+)%\s*confidence/);
                        const newConfidence = newConfidenceMatch ? parseInt(newConfidenceMatch[1], 10) : 0;
                        
                        // Consolidation logic
                        const existingIsInline = existingMarker.includes('Impacted by AI') && !existingMarker.includes('Agentic');
                        const existingIsAgentic = existingMarker.includes('Agentic');
                        const existingIsCombined = existingMarker.includes('Inline + Agentic');
                        
                        if (existingIsCombined) {
                            // Already combined, keep it
                            finalMarker = existingMarker;
                        } else if (existingIsInline && isAgentic) {
                            // Inline exists, adding agentic
                            finalMarker = 'Impacted by AI (Inline + Agentic)';
                        } else if (existingIsAgentic && !isAgentic) {
                            // Agentic exists, adding inline
                            finalMarker = 'Impacted by AI (Inline + Agentic)';
                        } else if (existingIsAgentic && isAgentic) {
                            // Both agentic - keep the HIGHER confidence score
                            if (existingConfidence >= newConfidence) {
                                finalMarker = existingMarker;
                                this.logger.appendLine(`[Tracker] Keeping higher confidence: ${existingConfidence}% >= ${newConfidence}%`);
                            } else {
                                this.logger.appendLine(`[Tracker] Updating to higher confidence: ${newConfidence}% > ${existingConfidence}%`);
                            }
                        }
                        // Otherwise, overwrite with new marker
                    }
                    
                    fs.writeFileSync(flagFile, finalMarker);
                    this.logger.appendLine(`[Tracker] ✓ Git flag set: ${finalMarker}`);
                    
                    // Track affected repository for potential cleanup
                    if (isAgentic) {
                        this._affectedRepositories.add(repo.rootUri.fsPath);
                    }
                    
                    // Note: Git hooks are now installed globally by extension.ts
                    // No need to install hooks per-repository
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
