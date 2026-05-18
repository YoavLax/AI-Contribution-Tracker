/**
 * AI Contribution Tracker - Git Flag Manager
 * 
 * Manages AI_IMPACT_PENDING flag files for git commit tagging.
 * Platform-agnostic implementation using IFileSystem interface.
 */

import { IFileSystem, IMarkerConsolidationResult, ILogger } from './interfaces';
import { MARKER_BASE, MARKER_INLINE_AGENTIC, CONFIDENCE_PATTERN } from './constants';

/**
 * Manages git AI impact flag files.
 * 
 * The flag file (AI_IMPACT_PENDING) is created in the .git directory
 * when AI-generated code is detected. The global commit-msg hook
 * reads this file and appends the marker to the commit message.
 */
export class GitFlagManager {
    private readonly fileSystem: IFileSystem;
    private readonly logger: ILogger | null;

    /**
     * Create a new GitFlagManager.
     * 
     * @param fileSystem - Platform-specific file system implementation
     * @param logger - Optional logger for debug output
     */
    constructor(fileSystem: IFileSystem, logger: ILogger | null = null) {
        this.fileSystem = fileSystem;
        this.logger = logger;
    }

    /**
     * Get the path to the AI impact flag file for a repository.
     * 
     * @param repositoryPath - Root path of the git repository
     * @returns Path to the AI_IMPACT_PENDING file
     */
    public getFlagFilePath(repositoryPath: string): string {
        return this.fileSystem.joinPath(repositoryPath, '.git', 'AI_IMPACT_PENDING');
    }

    /**
     * Check if a flag file exists for a repository.
     * 
     * @param repositoryPath - Root path of the git repository
     */
    public hasFlagFile(repositoryPath: string): boolean {
        const flagFile = this.getFlagFilePath(repositoryPath);
        return this.fileSystem.exists(flagFile);
    }

    /**
     * Read the current flag file content.
     * 
     * @param repositoryPath - Root path of the git repository
     * @returns Flag content or null if file doesn't exist
     */
    public readFlagFile(repositoryPath: string): string | null {
        const flagFile = this.getFlagFilePath(repositoryPath);
        if (!this.fileSystem.exists(flagFile)) {
            return null;
        }
        return this.fileSystem.readFile(flagFile).trim();
    }

    /**
     * Write a marker to the flag file with consolidation logic.
     * 
     * @param repositoryPath - Root path of the git repository
     * @param marker - The marker text to write
     * @param isAgentic - Whether this is an agentic (confidence-based) marker
     * @returns Consolidation result
     */
    public writeFlagFile(
        repositoryPath: string,
        marker: string,
        isAgentic: boolean
    ): IMarkerConsolidationResult {
        const flagFile = this.getFlagFilePath(repositoryPath);
        const gitDir = this.fileSystem.dirname(flagFile);
        
        // Ensure .git directory exists
        if (!this.fileSystem.exists(gitDir)) {
            return {
                marker: marker,
                wasUpdated: false,
                reason: '.git directory does not exist'
            };
        }
        
        // Check for existing flag and consolidate
        const existingMarker = this.readFlagFile(repositoryPath);
        const consolidationResult = this.consolidateMarker(existingMarker, marker, isAgentic);
        
        // Write the consolidated marker
        this.fileSystem.writeFile(flagFile, consolidationResult.marker);
        
        if (this.logger) {
            this.logger.log(`[GitFlagManager] Flag set: ${consolidationResult.marker} (${consolidationResult.reason})`);
        }
        
        return consolidationResult;
    }

    /**
     * Delete the flag file for a repository.
     * 
     * @param repositoryPath - Root path of the git repository
     * @returns true if file was deleted, false if it didn't exist
     */
    public deleteFlagFile(repositoryPath: string): boolean {
        const flagFile = this.getFlagFilePath(repositoryPath);
        if (!this.fileSystem.exists(flagFile)) {
            return false;
        }
        
        this.fileSystem.deleteFile(flagFile);
        
        if (this.logger) {
            this.logger.log(`[GitFlagManager] Flag deleted: ${repositoryPath}`);
        }
        
        return true;
    }

    /**
     * Clear agentic flags from a repository.
     * If the flag is combined (Inline + Agentic), reverts to inline only.
     * If the flag is agentic only, deletes the file entirely.
     * 
     * @param repositoryPath - Root path of the git repository
     * @returns true if any change was made
     */
    public clearAgenticFlag(repositoryPath: string): boolean {
        const existingMarker = this.readFlagFile(repositoryPath);
        if (!existingMarker) {
            return false;
        }
        
        if (existingMarker.includes('Inline + Agentic')) {
            // Revert to inline only
            const flagFile = this.getFlagFilePath(repositoryPath);
            this.fileSystem.writeFile(flagFile, MARKER_BASE);
            
            if (this.logger) {
                this.logger.log(`[GitFlagManager] Reverted to inline-only: ${repositoryPath}`);
            }
            return true;
        } else if (existingMarker.includes('Agentic')) {
            // Pure agentic, delete entirely
            this.deleteFlagFile(repositoryPath);
            return true;
        }
        
        return false;
    }

    /**
     * Consolidate existing and new markers.
     * 
     * Rules:
     * 1. If no existing marker, use new one
     * 2. If already combined, keep it
     * 3. If existing is inline and new is agentic (or vice versa), combine
     * 4. If both are agentic, keep higher confidence score
     * 
     * @param existingMarker - Current marker in flag file (or null)
     * @param newMarker - New marker to write
     * @param isAgentic - Whether new marker is agentic
     * @returns Consolidation result
     */
    public consolidateMarker(
        existingMarker: string | null,
        newMarker: string,
        isAgentic: boolean
    ): IMarkerConsolidationResult {
        // If no existing marker, use new one
        if (!existingMarker) {
            return {
                marker: newMarker,
                wasUpdated: true,
                reason: 'new flag created'
            };
        }
        
        // If already combined, keep it
        if (existingMarker.includes('Inline + Agentic')) {
            return {
                marker: existingMarker,
                wasUpdated: false,
                reason: 'already combined'
            };
        }

        // External hook markers (Copilot CLI / Claude Code) contain rich session data.
        // VS Code's heuristic confidence scoring should not overwrite them.
        const existingIsExternalAgent = existingMarker.includes('Agent mode:') || existingMarker.includes('Prompts:');
        if (existingIsExternalAgent) {
            if (!isAgentic) {
                // VS Code also detected an inline (Tab-accept) suggestion — note it
                const merged = existingMarker.replace('Impacted by AI (', 'Impacted by AI (Inline + ');
                return {
                    marker: merged,
                    wasUpdated: true,
                    reason: 'combined inline + external agent'
                };
            }
            // VS Code's confidence-score detection — don't overwrite external hook data
            return {
                marker: existingMarker,
                wasUpdated: false,
                reason: 'preserving external agent marker'
            };
        }
        
        // Determine existing marker type
        const existingIsInline = existingMarker.includes(MARKER_BASE) && !existingMarker.includes('Agentic');
        const existingIsAgentic = existingMarker.includes('Agentic');
        
        // If existing is inline and new is agentic, combine
        if (existingIsInline && isAgentic) {
            return {
                marker: MARKER_INLINE_AGENTIC,
                wasUpdated: true,
                reason: 'combined inline + agentic'
            };
        }
        
        // If existing is agentic and new is inline, combine
        if (existingIsAgentic && !isAgentic) {
            return {
                marker: MARKER_INLINE_AGENTIC,
                wasUpdated: true,
                reason: 'combined agentic + inline'
            };
        }
        
        // Both are agentic - keep higher confidence score
        if (existingIsAgentic && isAgentic) {
            const existingConfidence = this.extractConfidence(existingMarker);
            const newConfidence = this.extractConfidence(newMarker);
            
            if (existingConfidence >= newConfidence) {
                return {
                    marker: existingMarker,
                    wasUpdated: false,
                    reason: `keeping higher confidence: ${existingConfidence}% >= ${newConfidence}%`
                };
            } else {
                return {
                    marker: newMarker,
                    wasUpdated: true,
                    reason: `updating to higher confidence: ${newConfidence}% > ${existingConfidence}%`
                };
            }
        }
        
        // Default: overwrite with new marker
        return {
            marker: newMarker,
            wasUpdated: true,
            reason: 'overwrite'
        };
    }

    /**
     * Extract confidence percentage from a marker string.
     * 
     * @param marker - Marker string that may contain confidence info
     * @returns Confidence percentage (0 if not found)
     */
    public extractConfidence(marker: string): number {
        const match = marker.match(CONFIDENCE_PATTERN);
        return match ? parseInt(match[1], 10) : 0;
    }

    /**
     * Build an agentic marker string with confidence score.
     * 
     * @param confidenceScore - The confidence percentage (0-100)
     * @returns Formatted marker string
     */
    public buildAgenticMarker(confidenceScore: number): string {
        return `${MARKER_BASE} (Agentic - ${confidenceScore}% confidence)`;
    }

    /**
     * Build an inline marker string.
     * 
     * @param partial - Optional partial accept type (word, line)
     * @returns Formatted marker string
     */
    public buildInlineMarker(partial?: 'word' | 'line'): string {
        if (partial) {
            return `${MARKER_BASE} - Partial (${partial})`;
        }
        return MARKER_BASE;
    }

    /**
     * Find the git repository root for a file path.
     * Walks up the directory tree looking for a .git directory.
     * 
     * @param filePath - Path to a file or directory
     * @returns Repository root path or null if not found
     */
    public findRepositoryRoot(filePath: string): string | null {
        let currentPath = this.fileSystem.isDirectory(filePath) 
            ? filePath 
            : this.fileSystem.dirname(filePath);
        
        // Walk up the directory tree
        while (currentPath) {
            const gitDir = this.fileSystem.joinPath(currentPath, '.git');
            if (this.fileSystem.exists(gitDir)) {
                return currentPath;
            }
            
            const parentPath = this.fileSystem.dirname(currentPath);
            if (parentPath === currentPath) {
                // Reached root
                break;
            }
            currentPath = parentPath;
        }
        
        return null;
    }
}
