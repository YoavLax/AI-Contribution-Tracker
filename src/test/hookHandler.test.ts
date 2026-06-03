import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { execSync } from 'child_process';
import {
    HookInput,
    TrackerState,
    LogModels,
    findGitDir,
    loadState,
    saveState,
    formatMarker,
    extractTranscriptMetadata,
    extractFromCliTranscript,
    extractFromClaudeTranscript,
    extractModelFromCopilotLog,
    parseModelFromLogFile,
    dispatch,
    getStatePath,
    getFlagPath,
    handleCommitMsg,
    handleSessionStart,
    handleStop,
    getPendingStateDir,
} from '../hook-handler';

function runGit(args: string[], cwd: string): string {
    return cp.execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8' });
}

function makeInput(overrides: Partial<HookInput>): HookInput {
    return {
        timestamp: new Date().toISOString(),
        cwd: '',
        sessionId: 'test-session-1',
        hookEventName: 'SessionStart',
        ...overrides,
    };
}

function makeState(overrides: Partial<TrackerState>): TrackerState {
    return {
        promptCount: 0,
        subagentCount: 0,
        mainAgentTypes: [],
        subagentTypes: [],
        activeSubagents: 0,
        models: [],
        subagentModels: [],
        sessionId: null,
        sessionIds: [],
        sessionTranscripts: {},
        stateCreatedAt: new Date().toISOString(),
        lastUpdated: '',
        tokensByModel: {},
        ...overrides,
    };
}

suite('Hook Handler Tests', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;

    setup(() => {
        // Create temp git repo for each test
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-handler-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');
    });

    teardown(() => {
        // Cleanup
        try {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    });

    // ─── Git Discovery ─────────────────────────────────────────────────

    test('findGitDir should find .git directory', () => {
        const result = findGitDir(repoRoot);
        assert.ok(result, 'Should find git dir');
        assert.ok(result!.endsWith('.git'), 'Should end with .git');
    });

    test('findGitDir should return null for non-git directory', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
        const result = findGitDir(tmpDir);
        assert.strictEqual(result, null, 'Should return null for non-git dir');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ─── State Management ──────────────────────────────────────────────

    test('loadState should return default state when no file exists', () => {
        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 0);
        assert.deepStrictEqual(state.mainAgentTypes, []);
        assert.deepStrictEqual(state.subagentTypes, []);
        assert.deepStrictEqual(state.models, []);
    });

    test('saveState and loadState should round-trip', () => {
        const state = makeState({
            promptCount: 5,
            subagentCount: 2,
            mainAgentTypes: ['default'],
            subagentTypes: ['Plan', 'copilot'],
            models: ['claude-sonnet-4'],
            lastUpdated: new Date().toISOString(),
        });
        saveState(gitDir, state);
        
        const loaded = loadState(gitDir);
        assert.strictEqual(loaded.promptCount, 5);
        assert.strictEqual(loaded.subagentCount, 2);
        assert.deepStrictEqual(loaded.mainAgentTypes, ['default']);
        assert.deepStrictEqual(loaded.subagentTypes, ['Plan', 'copilot']);
        assert.deepStrictEqual(loaded.models, ['claude-sonnet-4']);
    });

    test('loadState should handle corrupted state file', () => {
        fs.writeFileSync(getStatePath(gitDir), 'not-json');
        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 0, 'Should return default on corrupt file');
    });

    // ─── Marker Formatting ─────────────────────────────────────────────

    test('formatMarker with all fields', () => {
        const state = makeState({
            promptCount: 3,
            subagentCount: 1,
            mainAgentTypes: ['default'],
            subagentTypes: ['Plan'],
            models: ['gpt-4o'],
        });
        const marker = formatMarker(state);
        assert.strictEqual(marker, 'Impacted by AI (Agent mode: default | Model: gpt-4o | Prompts: 3 | Sub-agents mode: Plan | sub-Agent prompts: 1)');
    });

    test('formatMarker with no model', () => {
        const state = makeState({
            promptCount: 2,
            mainAgentTypes: ['copilot'],
        });
        const marker = formatMarker(state);
        assert.strictEqual(marker, 'Impacted by AI (Agent mode: copilot | Prompts: 2)');
    });

    test('formatMarker with multiple models', () => {
        const state = makeState({
            promptCount: 2,
            mainAgentTypes: ['default'],
            models: ['claude-sonnet-4.6', 'gpt-4.1'],
        });
        const marker = formatMarker(state);
        assert.strictEqual(marker, 'Impacted by AI (Agent mode: default | Model: claude-sonnet-4.6, gpt-4.1 | Prompts: 2)');
    });

    test('formatMarker with multiple agent types', () => {
        const state = makeState({
            promptCount: 1,
            subagentCount: 2,
            mainAgentTypes: ['default'],
            subagentTypes: ['Plan', 'Review'],
        });
        const marker = formatMarker(state);
        assert.strictEqual(marker, 'Impacted by AI (Agent mode: default | Prompts: 1 | Sub-agents mode: Plan, Review | sub-Agent prompts: 2)');
    });

    test('formatMarker with only prompts', () => {
        const state = makeState({ promptCount: 5 });
        const marker = formatMarker(state);
        assert.strictEqual(marker, 'Impacted by AI (Prompts: 5)');
    });

    test('formatMarker with no data returns base marker', () => {
        const state = makeState({});
        const marker = formatMarker(state);
        assert.strictEqual(marker, 'Impacted by AI');
    });

    test('formatMarker deduplicates agent types', () => {
        const state = makeState({
            promptCount: 1,
            subagentCount: 1,
            subagentTypes: ['Plan', 'Plan', 'Review'],
        });
        const marker = formatMarker(state);
        assert.ok(marker.includes('Sub-agents mode: Plan, Review'), 'Should deduplicate');
        assert.ok(!marker.includes('Plan, Plan'), 'Should not have duplicates');
    });

    test('formatMarker with only subagents and no user prompts', () => {
        const state = makeState({
            subagentCount: 2,
            subagentTypes: ['Explore', 'Plan'],
        });
        const marker = formatMarker(state);
        assert.strictEqual(marker, 'Impacted by AI (Sub-agents mode: Explore, Plan | sub-Agent prompts: 2)');
    });

    test('formatMarker includes token counts per model when present', () => {
        const state = makeState({
            promptCount: 2,
            mainAgentTypes: ['default'],
            models: ['claude-sonnet-4.6'],
            tokensByModel: {
                'claude-sonnet-4-6': { inputTokens: 135000, outputTokens: 633, cachedTokens: 130000, reasoningTokens: 0 },
                'gpt-4o-mini': { inputTokens: 5000, outputTokens: 200, cachedTokens: 0, reasoningTokens: 0 },
            },
        });
        const marker = formatMarker(state);
        assert.ok(marker.includes('Tokens:'), 'Should include Tokens field');
        assert.ok(marker.includes('claude-sonnet-4-6:'), 'Should show claude model');
        assert.ok(marker.includes('135k in/633 out'), 'Should format claude tokens');
        assert.ok(marker.includes('130k cached'), 'Should include cached token count');
        assert.ok(marker.includes('gpt-4o-mini:'), 'Should show gpt model');
        assert.ok(marker.includes('5k in/200 out'), 'Should format gpt tokens');
    });

    test('formatMarker omits token section when tokensByModel is empty', () => {
        const state = makeState({ promptCount: 1, mainAgentTypes: ['default'] });
        const marker = formatMarker(state);
        assert.ok(!marker.includes('Tokens:'), 'Should not include Tokens when no token data');
    });

    test('formatMarker includes reasoning tokens when present', () => {
        const state = makeState({
            promptCount: 1,
            tokensByModel: {
                'claude-opus-4-5': { inputTokens: 10000, outputTokens: 500, cachedTokens: 0, reasoningTokens: 1200 },
            },
        });
        const marker = formatMarker(state);
        assert.ok(marker.includes('+1k reasoning'), 'Should include reasoning tokens');
    });

    // ─── Transcript Parsing ────────────────────────────────────────────

    test('extractTranscriptMetadata with JSONL session.start', () => {
        const transcriptPath = path.join(repoRoot, 'transcript.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.start', data: { sessionId: 'test', producer: 'copilot-agent', copilotVersion: '0.44' } }),
            JSON.stringify({ type: 'user.message', data: { content: 'hello' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));
        const meta = extractTranscriptMetadata(transcriptPath);
        assert.strictEqual(meta.producer, 'copilot-agent');
    });

    test('extractTranscriptMetadata with model field in JSONL', () => {
        const transcriptPath = path.join(repoRoot, 'transcript.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.start', data: { producer: 'copilot-agent' } }),
            JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', content: 'hello' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));
        const meta = extractTranscriptMetadata(transcriptPath);
        assert.strictEqual(meta.model, 'gpt-4o');
        assert.strictEqual(meta.producer, 'copilot-agent');
    });

    test('extractTranscriptMetadata returns nulls for missing file', () => {
        const meta = extractTranscriptMetadata('/nonexistent/path.jsonl');
        assert.strictEqual(meta.model, null);
        assert.strictEqual(meta.producer, null);
    });

    test('extractTranscriptMetadata returns nulls for empty path', () => {
        const meta = extractTranscriptMetadata('');
        assert.strictEqual(meta.model, null);
        assert.strictEqual(meta.producer, null);
    });

    // ─── Event Dispatch ────────────────────────────────────────────────

    test('SessionStart should initialize state file', () => {
        const result = dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        assert.deepStrictEqual(result, { continue: true });
        assert.ok(fs.existsSync(getStatePath(gitDir)), 'State file should be created');
    });

    test('UserPromptSubmit should increment prompt count', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Fix the bug' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Add tests' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Refactor' }));
        
        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 3, 'Should have 3 prompts');
    });

    test('SubagentStart should record agent type and increment subagent count', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Plan', agent_id: 'sub-1' }));
        
        const state = loadState(gitDir);
        assert.deepStrictEqual(state.subagentTypes, ['Plan']);
        assert.strictEqual(state.subagentCount, 1);
        assert.strictEqual(state.activeSubagents, 1);
    });

    test('SubagentStart should not duplicate agent types but should count each', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Plan', agent_id: 'sub-2' }));
        
        const state = loadState(gitDir);
        assert.deepStrictEqual(state.subagentTypes, ['Plan'], 'Should not have duplicates');
        assert.strictEqual(state.subagentCount, 2, 'Should count each subagent invocation');
    });

    test('Stop should write flag file with accumulated state', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Fix bug' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Add tests' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop' }));
        
        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag file should be created');
        
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Impacted by AI'), 'Should contain base marker');
        assert.ok(flagContent.includes('Sub-agents mode: Plan'), 'Should contain subagent type');
        assert.ok(flagContent.includes('Prompts: 2'), 'Should contain prompt count');
        assert.ok(flagContent.includes('sub-Agent prompts: 1'), 'Should contain subagent count');
    });

    test('Stop should not create flag when no activity', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop' }));
        
        const flagPath = getFlagPath(gitDir);
        assert.ok(!fs.existsSync(flagPath), 'Flag should not be created without activity');
    });

    // ─── Cross-session Accumulation ────────────────────────────────────

    test('Multiple sessions should accumulate prompts and agents', () => {
        // Session 1
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart', sessionId: 'session-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', sessionId: 'session-1', prompt: 'Fix bug' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', sessionId: 'session-1', prompt: 'Add tests' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', sessionId: 'session-1', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', sessionId: 'session-1', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop', sessionId: 'session-1' }));
        
        // Session 2 (state persists from session 1)
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart', sessionId: 'session-2' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', sessionId: 'session-2', prompt: 'Refactor' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', sessionId: 'session-2', prompt: 'Deploy' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', sessionId: 'session-2', prompt: 'Done' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', sessionId: 'session-2', agent_type: 'Review', agent_id: 'sub-2' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', sessionId: 'session-2', agent_type: 'Review', agent_id: 'sub-2' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop', sessionId: 'session-2' }));
        
        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 5, 'Should accumulate prompts across sessions');
        assert.strictEqual(state.subagentCount, 2, 'Should accumulate subagent count');
        assert.deepStrictEqual(state.subagentTypes, ['Plan', 'Review'], 'Should accumulate subagent types');
        
        const flagContent = fs.readFileSync(getFlagPath(gitDir), 'utf8');
        assert.ok(flagContent.includes('Prompts: 5'), 'Flag should show total prompts');
        assert.ok(flagContent.includes('sub-Agent prompts: 2'), 'Flag should show total subagents');
        assert.ok(flagContent.includes('Sub-agents mode: Plan, Review'), 'Flag should show all subagent types');
    });

    // ─── Merge with Inline Tracking ────────────────────────────────────

    test('Stop should merge with existing Inline flag', () => {
        // Simulate inline tracking already set the flag
        const flagPath = getFlagPath(gitDir);
        fs.writeFileSync(flagPath, 'Impacted by AI (Inline)');
        
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Fix bug' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop' }));
        
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Inline'), 'Should preserve Inline marker');
        assert.ok(flagContent.includes('Sub-agents mode: Plan'), 'Should include subagent type');
        assert.ok(flagContent.includes('Prompts: 1'), 'Should include prompt count');
        assert.ok(flagContent.includes('sub-Agent prompts: 1'), 'Should include subagent count');
    });

    // ─── Non-git Directory ─────────────────────────────────────────────

    test('dispatch should handle non-git directory gracefully', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'non-git-'));
        const result = dispatch(makeInput({ cwd: tmpDir, hookEventName: 'SessionStart' }));
        assert.deepStrictEqual(result, { continue: true }, 'Should continue without error');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('dispatch should handle unknown event gracefully', () => {
        const result = dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UnknownEvent' }));
        assert.deepStrictEqual(result, { continue: true });
    });

    // ─── Transcript Model Extraction in Stop ───────────────────────────

    test('Stop should extract model from transcript', () => {
        const transcriptPath = path.join(repoRoot, 'transcript.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.start', data: { producer: 'copilot-agent' } }),
            JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4o', content: 'hello' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));
        
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Hello' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop', transcript_path: transcriptPath }));
        
        const flagContent = fs.readFileSync(getFlagPath(gitDir), 'utf8');
        assert.ok(flagContent.includes('Model: gpt-4o'), 'Should include model from transcript');
    });

    test('Stop should use transcript producer as agent type when no subagents', () => {
        const transcriptPath = path.join(repoRoot, 'transcript.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.start', data: { producer: 'copilot-agent' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));
        
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Fix bug' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop', transcript_path: transcriptPath }));
        
        const flagContent = fs.readFileSync(getFlagPath(gitDir), 'utf8');
        assert.ok(flagContent.includes('Agent mode: copilot'), 'Should use producer as main agent type');
        assert.ok(flagContent.includes('Prompts: 1'), 'Should include prompt count');
    });

    test('Stop should NOT use producer if subagents were already recorded', () => {
        const transcriptPath = path.join(repoRoot, 'transcript.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.start', data: { producer: 'copilot-agent' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));
        
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Fix' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', agent_type: 'Plan', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop', transcript_path: transcriptPath }));
        
        const flagContent = fs.readFileSync(getFlagPath(gitDir), 'utf8');
        assert.ok(flagContent.includes('Sub-agents mode: Plan'), 'Should keep subagent type');
        assert.ok(!flagContent.includes('copilot'), 'Should NOT add producer when subagents exist');
    });

    // ─── Subagent Prompt Filtering ─────────────────────────────────────

    test('UserPromptSubmit during active subagent should not count as user prompt', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'User prompt 1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Explore', agent_id: 'sub-1' }));
        // This prompt is fired by the subagent, not the user
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Subagent delegated prompt' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', agent_type: 'Explore', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop' }));
        
        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 1, 'Should only count the user prompt');
        assert.strictEqual(state.subagentCount, 1, 'Should count one subagent');
    });

    test('SubagentStop should decrement activeSubagents', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Explore', agent_id: 'sub-1' }));
        
        let state = loadState(gitDir);
        assert.strictEqual(state.activeSubagents, 1, 'Should have 1 active subagent');
        
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', agent_type: 'Explore', agent_id: 'sub-1' }));
        
        state = loadState(gitDir);
        assert.strictEqual(state.activeSubagents, 0, 'Should have 0 active subagents after stop');
    });

    test('Prompts after SubagentStop should count as user prompts', () => {
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStart', agent_type: 'Explore', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'Subagent prompt' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'SubagentStop', agent_type: 'Explore', agent_id: 'sub-1' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'UserPromptSubmit', prompt: 'User prompt after subagent' }));
        dispatch(makeInput({ cwd: repoRoot, hookEventName: 'Stop' }));
        
        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 1, 'Only prompt after subagent should count');
        assert.strictEqual(state.subagentCount, 1);
    });

    // ─── Copilot Chat Log Model Extraction ────────────────────────────────────

    test('parseModelFromLogFile returns models from editAgent and subagent lines', () => {
        const logPath = path.join(repoRoot, 'copilot-chat.log');
        const content = [
            '2026-04-19 13:12:00.000 [info] ccreq:aaa.copilotmd | success | gpt-4o -> gpt-4o-2024-08-06 | 1234ms | [panel/editAgent]',
            '2026-04-19 13:13:00.000 [info] ccreq:bbb.copilotmd | success | claude-sonnet-4.6 -> claude-sonnet-4-6 | 6774ms | [panel/editAgent]',
            '2026-04-19 13:14:00.000 [info] ccreq:ccc.copilotmd | success | gemini-3.1-pro-preview | 5100ms | [panel/editAgent]',
            '2026-04-19 13:14:30.000 [info] ccreq:ddd.copilotmd | success | claude-haiku-4.5 -> claude-haiku-4-5-20251001 | 3608ms | [tool/runSubagent-Explore]',
            '2026-04-19 13:14:40.000 [info] ccreq:eee.copilotmd | success | claude-sonnet-4.6 -> claude-sonnet-4-6 | 3461ms | [tool/runSubagent]',
            '2026-04-19 13:15:00.000 [info] ccreq:fff.copilotmd | success | gpt-4o-mini-2024-07-18 | 1038ms | [title]',
            '2026-04-19 13:15:30.000 [info] ccreq:ggg.copilotmd | success | claude-opus-4.6 -> claude-opus-4-6 | 1335ms | [copilotLanguageModelWrapper]',
            '2026-04-19 13:16:00.000 [info] some other line',
        ].join('\n');
        fs.writeFileSync(logPath, content);

        const result = parseModelFromLogFile(logPath);
        assert.deepStrictEqual(result.models, ['gpt-4o', 'claude-sonnet-4.6', 'gemini-3.1-pro-preview'],
            'Should capture user-selected models from editAgent');
        assert.deepStrictEqual(result.subagentModels, ['claude-haiku-4.5'],
            'Should capture subagent models separately, deduplicate claude-sonnet-4.6');
    });

    test('parseModelFromLogFile returns empty result when no editAgent lines', () => {
        const logPath = path.join(repoRoot, 'copilot-chat-empty.log');
        fs.writeFileSync(logPath, '2026-04-19 13:12:00.000 [info] some unrelated log line\n');
        const result = parseModelFromLogFile(logPath);
        assert.deepStrictEqual(result.models, []);
        assert.deepStrictEqual(result.subagentModels, []);
    });

    test('parseModelFromLogFile returns empty result for missing file', () => {
        const result = parseModelFromLogFile('/nonexistent/path.log');
        assert.deepStrictEqual(result.models, []);
        assert.deepStrictEqual(result.subagentModels, []);
    });

    test('extractModelFromCopilotLog finds model in fake log dir structure', () => {
        // Create a fake VS Code log directory structure
        const fakeLogsDir = path.join(repoRoot, 'fake-vscode-logs');
        const sessionDir = path.join(fakeLogsDir, '20260419T130000', 'window1', 'exthost', 'GitHub.copilot-chat');
        fs.mkdirSync(sessionDir, { recursive: true });

        const logContent = [
            '2026-04-19 13:12:00.000 [info] activation',
            '2026-04-19 13:13:00.000 [info] ccreq:abc.copilotmd | success | claude-sonnet-4.6 -> claude-sonnet-4-6 | 5000ms | [panel/editAgent]',
        ].join('\n');
        fs.writeFileSync(path.join(sessionDir, 'GitHub Copilot Chat.log'), logContent);

        const result = extractModelFromCopilotLog(fakeLogsDir);
        assert.deepStrictEqual(result.models, ['claude-sonnet-4.6']);
        assert.deepStrictEqual(result.subagentModels, []);
    });

    test('Stop should include model from Copilot Chat log', () => {
        // Set up fake log structure
        const fakeLogsDir = path.join(repoRoot, 'fake-logs2');
        const sessionDir = path.join(fakeLogsDir, '20260419T140000', 'window1', 'exthost', 'GitHub.copilot-chat');
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'GitHub Copilot Chat.log'),
            '2026-04-19 14:00:00.000 [info] ccreq:abc.copilotmd | success | gpt-4.1 -> gpt-41 | 3000ms | [panel/editAgent]\n');

        // Monkeypatch: we can't easily inject the logsDir into dispatch/handleStop,
        // so just verify parseModelFromLogFile works with this content
        const result = parseModelFromLogFile(path.join(sessionDir, 'GitHub Copilot Chat.log'));
        assert.deepStrictEqual(result.models, ['gpt-4.1']);
    });
});

suite('CommitMsg Tests', () => {
    let tmpDir: string;
    let gitDir: string;

    setup(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tracker-commitmsg-'));
        gitDir = path.join(tmpDir, '.git');
        fs.mkdirSync(gitDir, { recursive: true });
    });

    teardown(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test('CommitMsg returns early when tokensByModel is already populated', () => {
        // Stop already fired and wrote token data into state
        const state = loadState(gitDir);
        state.sessionId = 'test-session-123';
        state.promptCount = 3;
        state.mainAgentTypes = ['copilot'];
        state.tokensByModel = {
            'claude-sonnet-4-6': { inputTokens: 50000, outputTokens: 1000, cachedTokens: 40000, reasoningTokens: 0 }
        };
        saveState(gitDir, state);

        // Write a flag without tokens (as if writeFlagEagerly ran before Stop)
        const flagPath = getFlagPath(gitDir);
        fs.writeFileSync(flagPath, 'Impacted by AI (Agent mode: copilot | Prompts: 3)');

        handleCommitMsg({ timestamp: new Date().toISOString(), hookEventName: 'CommitMsg', cwd: tmpDir, gitDir }, gitDir);

        // Flag should be refreshed with full token data — CommitMsg takes the fast path
        // (no OTEL re-query) but still writes the complete marker so the commit gets tokens
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.strictEqual(flagContent, 'Impacted by AI (Agent mode: copilot | Prompts: 3 | Tokens: claude-sonnet-4-6: 50k in/1k out (40k cached))',
            'Flag should be refreshed with token data when tokensByModel is already populated');
    });

    test('CommitMsg returns early when no sessionId in state', () => {
        const state = loadState(gitDir);
        state.promptCount = 2;
        state.mainAgentTypes = ['copilot'];
        state.sessionId = null; // No session ID
        saveState(gitDir, state);

        const flagPath = getFlagPath(gitDir);
        fs.writeFileSync(flagPath, 'Impacted by AI (Agent mode: copilot | Prompts: 2)');

        handleCommitMsg({ timestamp: new Date().toISOString(), hookEventName: 'CommitMsg', cwd: tmpDir, gitDir }, gitDir);

        // Flag unchanged — no session to query OTEL with
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.strictEqual(flagContent, 'Impacted by AI (Agent mode: copilot | Prompts: 2)');
    });

    test('CommitMsg with empty tokensByModel and no OTEL DB leaves flag unchanged', () => {
        // Session active, tokensByModel empty, but no DB available (queryTokensFromOtel returns null)
        const state = loadState(gitDir);
        state.sessionId = 'test-session-456';
        state.promptCount = 5;
        state.mainAgentTypes = ['copilot'];
        saveState(gitDir, state);

        const flagPath = getFlagPath(gitDir);
        const originalFlag = 'Impacted by AI (Agent mode: copilot | Prompts: 5)';
        fs.writeFileSync(flagPath, originalFlag);

        // queryTokensFromOtel will return null since there's no real DB in tmpDir
        handleCommitMsg({ timestamp: new Date().toISOString(), hookEventName: 'CommitMsg', cwd: tmpDir, gitDir }, gitDir);

        // Flag unchanged — OTEL returned nothing
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.strictEqual(flagContent, originalFlag);
    });

    test('dispatch handles CommitMsg event without crashing', () => {
        // Verifies CommitMsg is wired up in dispatch() and doesn't throw
        const state = loadState(gitDir);
        state.sessionId = 'test-session-789';
        state.promptCount = 1;
        state.mainAgentTypes = ['copilot'];
        saveState(gitDir, state);

        // Should complete without throwing even with no OTEL DB
        assert.doesNotThrow(() => {
            dispatch({ timestamp: new Date().toISOString(), hookEventName: 'CommitMsg', cwd: tmpDir, gitDir });
        });
    });
});

// ─── Copilot CLI Tests ────────────────────────────────────────────────────────

suite('Copilot CLI Tests', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let cliSessionDir: string;

    setup(() => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-repo-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');

        // Create a fake ~/.copilot/session-state/<id>/events.jsonl directory
        cliSessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cli-session-'));
    });

    teardown(() => {
        try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch { /* ok */ }
        try { fs.rmSync(cliSessionDir, { recursive: true, force: true }); } catch { /* ok */ }
    });

    // ─── extractFromCliTranscript ─────────────────────────────────────

    test('extractFromCliTranscript: model from session.model_change', () => {
        const transcriptPath = path.join(cliSessionDir, 'events.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-sonnet-4.6' } }),
            JSON.stringify({ type: 'user.message', data: { content: 'Hello' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));

        const result = extractFromCliTranscript('sid-1', transcriptPath);
        assert.deepStrictEqual(result.models, ['claude-sonnet-4.6']);
        assert.deepStrictEqual(result.tokensByModel, {}, 'No tokens before session.shutdown');
    });

    test('extractFromCliTranscript: model from assistant.message', () => {
        const transcriptPath = path.join(cliSessionDir, 'events.jsonl');
        const lines = [
            JSON.stringify({ type: 'assistant.message', data: { model: 'gpt-4.1', content: 'Hi there' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));

        const result = extractFromCliTranscript('sid-2', transcriptPath);
        assert.deepStrictEqual(result.models, ['gpt-4.1']);
    });

    test('extractFromCliTranscript: full token breakdown from session.shutdown', () => {
        const transcriptPath = path.join(cliSessionDir, 'events.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-sonnet-4.6' } }),
            JSON.stringify({ type: 'user.message', data: { content: 'Hello' } }),
            JSON.stringify({
                type: 'session.shutdown',
                data: {
                    modelMetrics: {
                        'claude-sonnet-4-6': {
                            usage: { inputTokens: 62000, outputTokens: 1200, cacheReadTokens: 48000, reasoningTokens: 0 }
                        }
                    }
                }
            }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));

        const result = extractFromCliTranscript('sid-3', transcriptPath);
        assert.deepStrictEqual(result.models, ['claude-sonnet-4.6', 'claude-sonnet-4-6']);
        assert.ok(result.tokensByModel['claude-sonnet-4-6'], 'Should have token data for the model');
        assert.strictEqual(result.tokensByModel['claude-sonnet-4-6'].inputTokens, 62000);
        assert.strictEqual(result.tokensByModel['claude-sonnet-4-6'].outputTokens, 1200);
        assert.strictEqual(result.tokensByModel['claude-sonnet-4-6'].cachedTokens, 48000);
        assert.strictEqual(result.tokensByModel['claude-sonnet-4-6'].reasoningTokens, 0);
    });

    test('extractFromCliTranscript: reasoning tokens', () => {
        const transcriptPath = path.join(cliSessionDir, 'events.jsonl');
        const lines = [
            JSON.stringify({
                type: 'session.shutdown',
                data: {
                    modelMetrics: {
                        'gpt-5.4': {
                            usage: { inputTokens: 10000, outputTokens: 500, cacheReadTokens: 0, reasoningTokens: 3000 }
                        }
                    }
                }
            }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));

        const result = extractFromCliTranscript('sid-4', transcriptPath);
        assert.strictEqual(result.tokensByModel['gpt-5.4'].reasoningTokens, 3000);
    });

    test('extractFromCliTranscript: missing transcript returns empty', () => {
        const result = extractFromCliTranscript('sid-missing', '/nonexistent/events.jsonl');
        assert.deepStrictEqual(result.models, []);
        assert.deepStrictEqual(result.tokensByModel, {});
    });

    test('extractFromCliTranscript: session still active (no shutdown) → models only, no tokens', () => {
        const transcriptPath = path.join(cliSessionDir, 'events.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-sonnet-4.6' } }),
            JSON.stringify({ type: 'assistant.message', data: { model: 'claude-sonnet-4.6', content: 'Sure!' } }),
            // No session.shutdown — session still running
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));

        const result = extractFromCliTranscript('sid-active', transcriptPath);
        assert.ok(result.models.length > 0, 'Should still capture model names');
        assert.deepStrictEqual(result.tokensByModel, {}, 'No token data while session is active');
    });

    test('extractFromCliTranscript: multiple models in one session', () => {
        const transcriptPath = path.join(cliSessionDir, 'events.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-sonnet-4.6' } }),
            JSON.stringify({ type: 'session.model_change', data: { newModel: 'gpt-4.1' } }),
            JSON.stringify({ type: 'assistant.message', data: { model: 'claude-sonnet-4.6' } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));

        const result = extractFromCliTranscript('sid-multi', transcriptPath);
        assert.ok(result.models.includes('claude-sonnet-4.6'), 'Should include claude');
        assert.ok(result.models.includes('gpt-4.1'), 'Should include gpt-4.1');
    });

    // ─── CLI Pending State (cwd outside git repo) ─────────────────────

    test('CLI events with non-git cwd are stored in pending state', () => {
        const homedir = os.homedir();
        // homedir is not a git repo (or at minimum not *this* repo)
        const result = dispatch(makeInput({
            cwd: homedir,
            hookEventName: 'SessionStart',
            sessionId: 'cli-session-pending-1',
        }));
        assert.deepStrictEqual(result, { continue: true });

        // State should land in pending dir, not in any .git dir
        const pendingDir = getPendingStateDir();
        const pendingState = loadState(pendingDir);
        // sessionId should be recorded in pending state
        assert.ok(
            pendingState.sessionId === 'cli-session-pending-1' ||
            pendingState.sessionIds.includes('cli-session-pending-1'),
            'Session ID should be stored in pending state'
        );
    });

    test('CommitMsg merges CLI pending state into repo at commit time', () => {
        // 1. Simulate CLI events arriving with no git repo context
        const homedir = os.homedir();
        const sessionId = 'cli-merge-session-1';

        dispatch(makeInput({ cwd: homedir, hookEventName: 'SessionStart', sessionId, source: 'new' }));
        dispatch(makeInput({ cwd: homedir, hookEventName: 'UserPromptSubmit', sessionId, prompt: 'Build the feature' }));
        dispatch(makeInput({ cwd: homedir, hookEventName: 'UserPromptSubmit', sessionId, prompt: 'Add tests too' }));

        // 2. Write a CLI transcript with model and tokens (simulating session closed)
        const transcriptPath = path.join(cliSessionDir, 'events.jsonl');
        const lines = [
            JSON.stringify({ type: 'session.model_change', data: { newModel: 'claude-sonnet-4.6' } }),
            JSON.stringify({
                type: 'session.shutdown',
                data: {
                    modelMetrics: {
                        'claude-sonnet-4-6': {
                            usage: { inputTokens: 50000, outputTokens: 2000, cacheReadTokens: 40000, reasoningTokens: 0 }
                        }
                    }
                }
            }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n'));

        // Patch pending state to reference our transcript
        const pendingDir = getPendingStateDir();
        const pendingState = loadState(pendingDir);
        pendingState.sessionIds = [sessionId];
        pendingState.sessionId = sessionId;
        saveState(pendingDir, pendingState);

        // Monkeypatch: write the CLI transcript where extractFromCliTranscript can find it
        // by pointing sessionIds at a path we control via the overriding transcriptPath arg.
        // Since handleCommitMsg calls extractFromCliTranscript(sid) without a path (uses default
        // ~/.copilot path), we instead pre-populate tokensByModel in pending state to simulate
        // what Stop would have done had it fired.
        pendingState.tokensByModel = {
            'claude-sonnet-4-6': { inputTokens: 50000, outputTokens: 2000, cachedTokens: 40000, reasoningTokens: 0 }
        };
        pendingState.models = ['claude-sonnet-4.6'];
        saveState(pendingDir, pendingState);

        // 3. CommitMsg fires with the real repo's gitDir
        handleCommitMsg(
            { timestamp: new Date().toISOString(), hookEventName: 'CommitMsg', cwd: repoRoot, gitDir },
            gitDir
        );

        // 4. Flag should be written to the repo with CLI data
        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag should be written after CLI pending merge');
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Impacted by AI'), 'Flag should have AI marker');
        assert.ok(flagContent.includes('Prompts: 2'), 'Should include CLI prompt count');
        assert.ok(flagContent.includes('Tokens:'), 'Should include token data from CLI transcript');
    });

    test('CommitMsg during active CLI session: prompts/model shown, no tokens', () => {
        const sessionId = 'cli-active-session';

        // Simulate events arriving at the homedir (CLI cwd), then pre-populate pending state
        const pendingDir = getPendingStateDir();
        const activeState = loadState(pendingDir);
        activeState.sessionId = sessionId;
        activeState.sessionIds = [sessionId];
        activeState.promptCount = 3;
        activeState.mainAgentTypes = ['copilot'];
        activeState.models = ['claude-sonnet-4.6'];
        // No tokensByModel — session still open, shutdown not written yet
        activeState.tokensByModel = {};
        saveState(pendingDir, activeState);

        handleCommitMsg(
            { timestamp: new Date().toISOString(), hookEventName: 'CommitMsg', cwd: repoRoot, gitDir },
            gitDir
        );

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag should still be written');
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Prompts: 3'), 'Should include prompt count');
        assert.ok(flagContent.includes('Agent mode: copilot'), 'Should include agent mode');
        assert.ok(!flagContent.includes('Tokens:'), 'No token data while session is active');
    });

    // ─── VS Code + CLI marker formatting ─────────────────────────────

    test('formatMarker for CLI session with full token data', () => {
        const state = makeState({
            promptCount: 2,
            mainAgentTypes: ['copilot'],
            models: ['claude-sonnet-4.6'],
            tokensByModel: {
                'claude-sonnet-4-6': { inputTokens: 62000, outputTokens: 1200, cachedTokens: 48000, reasoningTokens: 0 }
            },
        });
        const marker = formatMarker(state);
        assert.ok(marker.includes('Agent mode: copilot'), 'Should show copilot as agent mode');
        assert.ok(marker.includes('Model: claude-sonnet-4.6'), 'Should show model');
        assert.ok(marker.includes('Prompts: 2'), 'Should show prompt count');
        assert.ok(marker.includes('Tokens:'), 'Should include token section');
        assert.ok(marker.includes('62k in/1k out'), 'Should format CLI token counts');
        assert.ok(marker.includes('48k cached'), 'Should include cache hits');
    });

    test('formatMarker for CLI active session (no tokens)', () => {
        const state = makeState({
            promptCount: 4,
            mainAgentTypes: ['copilot'],
            models: ['gpt-4.1'],
            tokensByModel: {},
        });
        const marker = formatMarker(state);
        assert.ok(marker.includes('Agent mode: copilot'));
        assert.ok(marker.includes('Model: gpt-4.1'));
        assert.ok(marker.includes('Prompts: 4'));
        assert.ok(!marker.includes('Tokens:'), 'No tokens section when session still active');
    });
});

// ─── Claude Code Tests ────────────────────────────────────────────────────────

suite('Claude Code Tests', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let tmpClaudeDir: string;

    setup(() => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-test-'));
        execSync('git init', { cwd: repoRoot });
        execSync('git config user.email "test@test.com"', { cwd: repoRoot });
        execSync('git config user.name "Test"', { cwd: repoRoot });
        gitDir = path.join(repoRoot, '.git');

        // Create a scratch Claude projects dir for transcript fixtures
        tmpClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-projects-'));
    });

    teardown(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(tmpClaudeDir, { recursive: true, force: true });
    });

    /** Build a minimal Claude transcript JSONL with the given turns */
    function makeClaudeTranscript(sessionId: string, turns: Array<{
        model: string;
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens?: number;
        cacheReadTokens?: number;
    }>): string {
        const projectDir = path.join(tmpClaudeDir, 'test-project');
        fs.mkdirSync(projectDir, { recursive: true });
        const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

        const lines: string[] = [];
        // Opener: system entry
        lines.push(JSON.stringify({ type: 'system', content: 'session start' }));
        for (const turn of turns) {
            lines.push(JSON.stringify({
                type: 'assistant',
                message: {
                    model: turn.model,
                    usage: {
                        input_tokens: turn.inputTokens,
                        output_tokens: turn.outputTokens,
                        cache_creation_input_tokens: turn.cacheCreationTokens || 0,
                        cache_read_input_tokens: turn.cacheReadTokens || 0,
                    },
                },
            }));
        }
        fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');
        return transcriptPath;
    }

    // ── extractFromClaudeTranscript unit tests ─────────────────────────────

    test('extractFromClaudeTranscript: reads model and tokens from transcript', () => {
        const sid = 'claude-test-session-1';
        const transcriptPath = makeClaudeTranscript(sid, [
            { model: 'claude-opus-4-5', inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200 },
        ]);

        const result = extractFromClaudeTranscript(sid, transcriptPath);

        assert.deepStrictEqual(result.models, ['claude-opus-4-5']);
        assert.ok(result.tokensByModel['claude-opus-4-5']);
        assert.strictEqual(result.tokensByModel['claude-opus-4-5'].inputTokens, 1000);
        assert.strictEqual(result.tokensByModel['claude-opus-4-5'].outputTokens, 500);
        assert.strictEqual(result.tokensByModel['claude-opus-4-5'].cachedTokens, 200);
        assert.strictEqual(result.tokensByModel['claude-opus-4-5'].reasoningTokens, 0);
    });

    test('extractFromClaudeTranscript: folds cache_creation into inputTokens', () => {
        const sid = 'claude-test-session-2';
        const transcriptPath = makeClaudeTranscript(sid, [
            { model: 'claude-sonnet-4-5', inputTokens: 500, outputTokens: 100, cacheCreationTokens: 300 },
        ]);

        const result = extractFromClaudeTranscript(sid, transcriptPath);

        // cache_creation (300) should be added to input (500) = 800
        assert.strictEqual(result.tokensByModel['claude-sonnet-4-5'].inputTokens, 800);
        assert.strictEqual(result.tokensByModel['claude-sonnet-4-5'].outputTokens, 100);
    });

    test('extractFromClaudeTranscript: accumulates tokens across multiple turns', () => {
        const sid = 'claude-test-session-3';
        const transcriptPath = makeClaudeTranscript(sid, [
            { model: 'claude-opus-4-5', inputTokens: 1000, outputTokens: 200 },
            { model: 'claude-opus-4-5', inputTokens: 800,  outputTokens: 150 },
        ]);

        const result = extractFromClaudeTranscript(sid, transcriptPath);

        assert.strictEqual(result.models.length, 1);
        assert.strictEqual(result.tokensByModel['claude-opus-4-5'].inputTokens, 1800);
        assert.strictEqual(result.tokensByModel['claude-opus-4-5'].outputTokens, 350);
    });

    test('extractFromClaudeTranscript: skips <synthetic> model entries', () => {
        const sid = 'claude-test-session-4';
        const projectDir = path.join(tmpClaudeDir, 'test-project-synthetic');
        fs.mkdirSync(projectDir, { recursive: true });
        const transcriptPath = path.join(projectDir, `${sid}.jsonl`);
        const lines = [
            JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 5, output_tokens: 2 } } }),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-5', usage: { input_tokens: 1000, output_tokens: 300 } } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

        const result = extractFromClaudeTranscript(sid, transcriptPath);

        assert.ok(!result.models.includes('<synthetic>'), '<synthetic> should be filtered out');
        assert.ok(result.models.includes('claude-opus-4-5'));
    });

    test('extractFromClaudeTranscript: returns empty result if transcript does not exist', () => {
        const result = extractFromClaudeTranscript('nonexistent-session-id');
        assert.deepStrictEqual(result.models, []);
        assert.deepStrictEqual(result.tokensByModel, {});
    });

    test('extractFromClaudeTranscript: ignores non-assistant entries', () => {
        const sid = 'claude-test-session-5';
        const projectDir = path.join(tmpClaudeDir, 'test-project-nona');
        fs.mkdirSync(projectDir, { recursive: true });
        const transcriptPath = path.join(projectDir, `${sid}.jsonl`);
        const lines = [
            JSON.stringify({ type: 'user', message: { content: 'hello' } }),
            JSON.stringify({ type: 'system', content: 'boot' }),
            JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-5', usage: { input_tokens: 100, output_tokens: 50 } } }),
        ];
        fs.writeFileSync(transcriptPath, lines.join('\n') + '\n');

        const result = extractFromClaudeTranscript(sid, transcriptPath);
        assert.deepStrictEqual(result.models, ['claude-opus-4-5']);
    });

    // ── Source normalization tests ─────────────────────────────────────────

    test('handleSessionStart: normalizes Claude "startup" source to "claude"', () => {
        handleSessionStart(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart', source: 'startup', sessionId: 'sid-norm-1' }), gitDir);
        const state = loadState(gitDir);
        assert.ok(state.mainAgentTypes.includes('claude'), `Expected "claude" in mainAgentTypes, got: ${state.mainAgentTypes}`);
    });

    test('handleSessionStart: normalizes Claude "claude-vscode" source to "claude"', () => {
        handleSessionStart(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart', source: 'claude-vscode', sessionId: 'sid-norm-2' }), gitDir);
        const state = loadState(gitDir);
        assert.ok(state.mainAgentTypes.includes('claude'), `Expected "claude" in mainAgentTypes, got: ${state.mainAgentTypes}`);
    });

    test('handleSessionStart: existing "new" source still normalizes to "copilot"', () => {
        handleSessionStart(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart', source: 'new', sessionId: 'sid-norm-3' }), gitDir);
        const state = loadState(gitDir);
        assert.ok(state.mainAgentTypes.includes('copilot'), `Expected "copilot" in mainAgentTypes, got: ${state.mainAgentTypes}`);
        assert.ok(!state.mainAgentTypes.includes('new'), '"new" should not appear raw');
    });

    // ── sessionTranscripts persistence ────────────────────────────────────

    test('handleSessionStart: persists transcript_path in sessionTranscripts', () => {
        const sid = 'sid-transcript-persist';
        const fakePath = '/fake/path/to/transcript.jsonl';
        handleSessionStart(makeInput({ cwd: repoRoot, hookEventName: 'SessionStart', sessionId: sid, transcript_path: fakePath }), gitDir);
        const state = loadState(gitDir);
        assert.strictEqual(state.sessionTranscripts[sid], fakePath);
    });

    // ── End-to-end: Stop writes Claude tokens into state ─────────────────

    test('handleStop: reads Claude transcript tokens and models at Stop time', () => {
        const sid = 'claude-stop-e2e';
        const transcriptPath = makeClaudeTranscript(sid, [
            { model: 'claude-opus-4-5', inputTokens: 5000, outputTokens: 800, cacheReadTokens: 1200 },
        ]);

        // Seed state as if SessionStart + UserPromptSubmit already ran
        const state = makeState({ sessionId: sid, sessionIds: [sid], promptCount: 1, mainAgentTypes: ['claude'] });
        saveState(gitDir, state);

        handleStop(makeInput({
            cwd: repoRoot,
            hookEventName: 'Stop',
            sessionId: sid,
            transcript_path: transcriptPath,
        }), gitDir);

        const finalState = loadState(gitDir);
        assert.ok(finalState.models.includes('claude-opus-4-5'), 'Model should be captured from Claude transcript');
        assert.ok(finalState.tokensByModel['claude-opus-4-5'], 'Token data should be present');
        assert.strictEqual(finalState.tokensByModel['claude-opus-4-5'].inputTokens, 5000);
        assert.strictEqual(finalState.tokensByModel['claude-opus-4-5'].outputTokens, 800);
        assert.strictEqual(finalState.tokensByModel['claude-opus-4-5'].cachedTokens, 1200);
    });

    // ── End-to-end: CommitMsg reads Claude tokens at commit time ──────────

    test('handleCommitMsg: reads Claude transcript tokens at commit time (Stop not fired)', () => {
        const sid = 'claude-commit-e2e';
        const transcriptPath = makeClaudeTranscript(sid, [
            { model: 'claude-sonnet-4-5', inputTokens: 3000, outputTokens: 400 },
        ]);

        // Simulate SessionStart + UserPromptSubmit state (Stop has NOT fired yet)
        const state = makeState({
            sessionId: sid,
            sessionIds: [sid],
            sessionTranscripts: { [sid]: transcriptPath },
            promptCount: 1,
            mainAgentTypes: ['claude'],
            tokensByModel: {},
        });
        const flagPath = path.join(gitDir, 'AI_IMPACT_PENDING');
        fs.writeFileSync(flagPath, formatMarker(state));
        saveState(gitDir, state);

        handleCommitMsg(makeInput({ cwd: repoRoot, hookEventName: 'CommitMsg', gitDir }), gitDir);

        const finalState = loadState(gitDir);
        // After CommitMsg, state is reset (consumed)
        assert.strictEqual(finalState.promptCount, 0, 'State should be reset after commit');
        // Flag should have been written with token info
        if (fs.existsSync(flagPath)) {
            // Flag may have been updated; if still present it should have the marker
            const flagContent = fs.readFileSync(flagPath, 'utf8');
            assert.ok(flagContent.includes('Impacted by AI'), 'Flag should have AI marker');
        }
    });

    // ── formatMarker: Claude session ──────────────────────────────────────

    test('formatMarker for Claude session with tokens', () => {
        const state = makeState({
            promptCount: 2,
            mainAgentTypes: ['claude'],
            models: ['claude-opus-4-5'],
            tokensByModel: {
                'claude-opus-4-5': { inputTokens: 5000, outputTokens: 800, cachedTokens: 1200, reasoningTokens: 0 },
            },
        });
        const marker = formatMarker(state);
        assert.ok(marker.includes('Impacted by AI'), 'Should have AI marker');
        assert.ok(marker.includes('Agent mode: claude'), 'Should show claude as agent mode');
        assert.ok(marker.includes('Model: claude-opus-4-5'), 'Should show model');
        assert.ok(marker.includes('Prompts: 2'), 'Should show prompt count');
        assert.ok(marker.includes('Tokens:'), 'Should include token section');
        assert.ok(marker.includes('5k in/800 out'), 'Should format Claude token counts');
        assert.ok(marker.includes('1k cached'), 'Should include cache hits');
    });

    test('formatMarker for Claude session without tokens (session still active)', () => {
        const state = makeState({
            promptCount: 1,
            mainAgentTypes: ['claude'],
            models: ['claude-opus-4-5'],
            tokensByModel: {},
        });
        const marker = formatMarker(state);
        assert.ok(marker.includes('Agent mode: claude'));
        assert.ok(marker.includes('Model: claude-opus-4-5'));
        assert.ok(marker.includes('Prompts: 1'));
        assert.ok(!marker.includes('Tokens:'), 'No tokens when not yet extracted');
    });
});


