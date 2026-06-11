import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { AIContributionTracker, extractSessionId } from '../opencode-plugin';
import { loadState, getFlagPath, getStatePath } from '../hook-handler';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function runGit(args: string[], cwd: string): string {
    return cp.execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8' });
}

function makeMockPluginInput(repoRoot: string) {
    return {
        client: {
            app: {
                log: async () => {},
            },
        },
        directory: repoRoot,
        worktree: repoRoot,
        project: {} as any,
        $: {} as any,
        serverUrl: new URL('http://localhost'),
    };
}

function makeSessionCreatedEvent(sessionId: string, agent = 'build', parentId?: string) {
    return {
        type: 'session.created' as const,
        properties: {
            info: {
                id: sessionId,
                sessionID: sessionId,
                agent,
                parentID: parentId,
            },
        },
    };
}

function makeSessionIdleEvent(sessionId: string) {
    return {
        type: 'session.idle' as const,
        properties: { sessionID: sessionId },
    };
}

function makeChatMessageInput(sessionId: string, agent = 'build', modelId = 'claude-sonnet-4-6') {
    return {
        sessionID: sessionId,
        agent,
        model: { providerID: 'anthropic', modelID: modelId },
        messageID: 'msg_test',
    };
}

function makeMessageUpdatedEvent(sessionId: string, opts: {
    messageId?: string;
    role?: string;
    finish?: string;
    modelId?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
}) {
    return {
        type: 'message.updated' as const,
        properties: {
            info: {
                id: opts.messageId ?? 'msg_1',
                sessionID: sessionId,
                role: opts.role ?? 'assistant',
                // Use explicit undefined check so empty string '' is preserved (in-progress test)
                finish: opts.finish !== undefined ? opts.finish : 'stop',
                modelID: opts.modelId ?? 'claude-sonnet-4-6',
                tokens: {
                    input: opts.inputTokens ?? 0,
                    output: opts.outputTokens ?? 0,
                    reasoning: opts.reasoningTokens ?? 0,
                    cache: { read: opts.cachedTokens ?? 0, write: 0 },
                },
            },
        },
    };
}

// ─── Suite: extractSessionId ──────────────────────────────────────────────────


/** Simulate a file read to trigger gitDir resolution (v3 resolves only from file paths) */
async function triggerGitDirResolution(hooks: any, sessionId: string, repoRoot: string) {
    await hooks['tool.execute.after']!({ tool: 'read', sessionID: sessionId, callID: 'resolve_gitdir', args: { filePath: path.join(repoRoot, 'dummy.txt') } } as any, {} as any);
}

suite('OpenCode Plugin — extractSessionId', () => {

    test('extracts from direct sessionID property', () => {
        const result = extractSessionId({ properties: { sessionID: 'ses_direct' } });
        assert.strictEqual(result, 'ses_direct');
    });

    test('extracts from nested info.sessionID', () => {
        const result = extractSessionId({ properties: { info: { sessionID: 'ses_nested_id' } } });
        assert.strictEqual(result, 'ses_nested_id');
    });

    test('extracts from nested info.id (third fallback path)', () => {
        // info has no sessionID/session_id, only id
        const result = extractSessionId({ properties: { info: { id: 'ses_info_id' } } });
        assert.strictEqual(result, 'ses_info_id');
    });

    test('returns null when no session ID present in properties', () => {
        const result = extractSessionId({ properties: {} });
        assert.strictEqual(result, null);
    });

    test('returns null when properties field is missing entirely', () => {
        const result = extractSessionId({});
        assert.strictEqual(result, null);
    });
});

// ─── Suite: session lifecycle ─────────────────────────────────────────────────

suite('OpenCode Plugin — session lifecycle', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let hooks: any;

    setup(async () => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');
        hooks = await AIContributionTracker(makeMockPluginInput(repoRoot) as any);
    });

    teardown(() => {
        try {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        } catch {
            // ignore cleanup errors
        }
    });

    test('session.created initializes state file with sessionId', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_lc_01') } as any);
        await triggerGitDirResolution(hooks, 'ses_lc_01', repoRoot);

        assert.ok(fs.existsSync(getStatePath(gitDir)), 'State file should be created');
        const state = loadState(gitDir);
        assert.strictEqual(state.sessionId, 'ses_lc_01');
    });

    test('session.created with agent sets opencode/ prefix in mainAgentTypes', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_lc_02', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_lc_02', repoRoot);

        const state = loadState(gitDir);
        assert.ok(
            state.mainAgentTypes.includes('opencode/build'),
            `Expected opencode/build in mainAgentTypes, got: ${JSON.stringify(state.mainAgentTypes)}`
        );
    });

    test('session.created with parentID marks as subagent — prompts not counted', async () => {
        // Parent session (non-subagent)
        await hooks.event({ event: makeSessionCreatedEvent('ses_lc_03p', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_lc_03p', repoRoot);
        // Subagent session with parentID set
        await hooks.event({ event: makeSessionCreatedEvent('ses_lc_03s', 'build', 'ses_lc_03p') } as any);
        await triggerGitDirResolution(hooks, 'ses_lc_03s', repoRoot);

        await hooks['chat.message'](makeChatMessageInput('ses_lc_03s'), null);

        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 0,
            'Subagent session prompts should not increment promptCount');
    });

    test('session.idle triggers Stop and writes AI_IMPACT_PENDING flag', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_lc_04', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_lc_04', repoRoot);
        await hooks['chat.message'](makeChatMessageInput('ses_lc_04'), null);
        await hooks.event({ event: makeSessionIdleEvent('ses_lc_04') } as any);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'AI_IMPACT_PENDING flag should be written on session.idle');
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Impacted by AI'), 'Flag should contain base marker');
    });

    test('session.status with idle type also triggers Stop', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_lc_05', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_lc_05', repoRoot);
        await hooks['chat.message'](makeChatMessageInput('ses_lc_05'), null);

        // session.status with status.type === 'idle' should behave identically to session.idle
        await hooks.event({
            event: {
                type: 'session.status',
                properties: { sessionID: 'ses_lc_05', status: { type: 'idle' } },
            },
        } as any);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag should be written on session.status with idle type');
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Impacted by AI'));
    });

    test('session.deleted cleans up session — subsequent prompts have no effect', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_lc_06', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_lc_06', repoRoot);

        await hooks.event({
            event: { type: 'session.deleted', properties: { sessionID: 'ses_lc_06' } },
        } as any);

        await hooks['chat.message'](makeChatMessageInput('ses_lc_06'), null);

        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 0,
            'After session.deleted, chat.message should not increment promptCount');
    });
});

// ─── Suite: chat.message ──────────────────────────────────────────────────────

suite('OpenCode Plugin — chat.message', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let hooks: any;

    setup(async () => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');
        hooks = await AIContributionTracker(makeMockPluginInput(repoRoot) as any);
    });

    teardown(() => {
        try {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        } catch {}
    });

    test('user prompt increments promptCount and records model', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_cm_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_cm_01', repoRoot);
        await hooks['chat.message'](makeChatMessageInput('ses_cm_01', 'build', 'claude-sonnet-4-6'), null);

        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 1, 'promptCount should be 1 after one prompt');
        assert.ok(state.models.includes('claude-sonnet-4-6'), 'Model should be recorded in state');
    });

    test('subagent session prompt does NOT increment parent promptCount', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_cm_02p', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_cm_02p', repoRoot);
        await hooks.event({ event: makeSessionCreatedEvent('ses_cm_02s', 'build', 'ses_cm_02p') } as any);
        await triggerGitDirResolution(hooks, 'ses_cm_02s', repoRoot);

        await hooks['chat.message'](makeChatMessageInput('ses_cm_02s', 'build', 'claude-sonnet-4-6'), null);

        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 0,
            'Subagent session prompts should not increment parent promptCount');
    });

    test('eager flag written after first prompt (before session.idle)', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_cm_03', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_cm_03', repoRoot);

        const flagPath = getFlagPath(gitDir);

        await hooks['chat.message'](makeChatMessageInput('ses_cm_03', 'build', 'claude-sonnet-4-6'), null);

        assert.ok(fs.existsSync(flagPath),
            'Flag should be written eagerly after chat.message (before session.idle)');
        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Impacted by AI'), 'Eager flag must contain base marker');
    });
});

// ─── Suite: lazy git dir resolution ───────────────────────────────────────────

suite('OpenCode Plugin — lazy git dir resolution', function () {
    this.timeout(10000);

    let repoRoot: string;
    let parentDir: string;
    let gitDir: string;
    let hooks: any;

    setup(async () => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        parentDir = path.dirname(repoRoot);
        gitDir = path.join(repoRoot, '.git');
        hooks = await AIContributionTracker(makeMockPluginInput(parentDir) as any);
    });

    teardown(() => {
        try {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        } catch {}
    });

    test('resolves gitDir from tool filePath after session starts in a non-git parent', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_lazy_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_lazy_01', repoRoot);

        const testFile = path.join(repoRoot, 'test.ts');
        fs.writeFileSync(testFile, 'console.log("hi");\n');

        await hooks['tool.execute.after']({
            sessionID: 'ses_lazy_01',
            tool: 'edit',
            callID: 'call_lazy_01',
            args: { filePath: testFile },
        } as any, null);

        await hooks['chat.message'](makeChatMessageInput('ses_lazy_01', 'build', 'claude-sonnet-4-6'), null);

        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 1, 'Prompt should count after lazy gitDir resolution');
        assert.ok(state.mainAgentTypes.includes('opencode/build'), 'Late SessionStart should record agent name');
    });

    test('message.updated can also resolve gitDir lazily from a prior filePath', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_lazy_02', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_lazy_02', repoRoot);

        const testFile = path.join(repoRoot, 'test-message.ts');
        fs.writeFileSync(testFile, 'console.log("hello");\n');

        await hooks['tool.execute.after']({
            sessionID: 'ses_lazy_02',
            tool: 'write',
            callID: 'call_lazy_02',
            args: { filePath: testFile },
        } as any, null);

        await hooks.event({
            event: makeMessageUpdatedEvent('ses_lazy_02', {
                messageId: 'msg_lazy_02',
                inputTokens: 1234,
                outputTokens: 56,
            }),
        } as any);

        const state = loadState(gitDir);
        assert.strictEqual(state.tokensByModel['claude-sonnet-4-6'].inputTokens, 1234);
        assert.strictEqual(state.tokensByModel['claude-sonnet-4-6'].outputTokens, 56);
    });

    test('re-resolves gitDir when previously resolved gitDir no longer exists', async () => {
        // Simulate scenario where a session had a gitDir that was then deleted
        // (e.g. temp repo cleaned up mid-session) — the fix in index.ts adds
        // !fs.existsSync(sess.gitDir) to force re-resolution from the next file path.

        // Create a second repo so the plugin can re-resolve to it
        const secondRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-rersolve-'));
        runGit(['init'], secondRepo);
        runGit(['config', 'user.email', '"test@example.com"'], secondRepo);
        runGit(['config', 'user.name', '"Test User"'], secondRepo);
        const secondGitDir = path.join(secondRepo, '.git');

        try {
            await hooks.event({ event: makeSessionCreatedEvent('ses_rr_01', 'build') } as any);
            // Resolve to the original repoRoot first
            await triggerGitDirResolution(hooks, 'ses_rr_01', repoRoot);

            // Destroy the original repo to simulate deletion
            fs.rmSync(repoRoot, { recursive: true, force: true });

            // Now re-trigger gitDir resolution with a file from the second repo
            const testFile = path.join(secondRepo, 'rr.ts');
            fs.writeFileSync(testFile, 'export {};\n');
            await hooks['tool.execute.after']({
                sessionID: 'ses_rr_01',
                tool: 'read',
                callID: 'call_rr_01',
                args: { filePath: testFile },
            } as any, null);

            await hooks['chat.message'](makeChatMessageInput('ses_rr_01', 'build', 'gpt-4o'), null);

            // State should now be written to the second repo
            const state = loadState(secondGitDir);
            assert.strictEqual(state.promptCount, 1,
                'After re-resolution to secondRepo, prompt should be counted there');
        } finally {
            try { fs.rmSync(secondRepo, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    });
});

// ─── Suite: token tracking ────────────────────────────────────────────────────

suite('OpenCode Plugin — token tracking', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let hooks: any;

    setup(async () => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');
        hooks = await AIContributionTracker(makeMockPluginInput(repoRoot) as any);
    });

    teardown(() => {
        try {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        } catch {}
    });

    test('completed assistant message tokens accumulate in tokensByModel', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_tt_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_tt_01', repoRoot);
        await hooks.event({
            event: makeMessageUpdatedEvent('ses_tt_01', {
                messageId: 'msg_tt_01',
                inputTokens: 50000,
                outputTokens: 633,
                cachedTokens: 45000,
            }),
        } as any);

        const state = loadState(gitDir);
        assert.ok(state.tokensByModel['claude-sonnet-4-6'], 'Should have claude model entry');
        assert.strictEqual(state.tokensByModel['claude-sonnet-4-6'].inputTokens, 95000, 'inputTokens = fresh (50k) + cached (45k)');
        assert.strictEqual(state.tokensByModel['claude-sonnet-4-6'].outputTokens, 633);
        assert.strictEqual(state.tokensByModel['claude-sonnet-4-6'].cachedTokens, 45000);
    });

    test('in-progress message (no finish) is ignored for token tracking', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_tt_02', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_tt_02', repoRoot);
        await hooks.event({
            event: makeMessageUpdatedEvent('ses_tt_02', {
                messageId: 'msg_tt_02',
                finish: '',  // empty string = in-progress, plugin checks !info.finish
                inputTokens: 1000,
                outputTokens: 100,
            }),
        } as any);

        const state = loadState(gitDir);
        assert.deepStrictEqual(state.tokensByModel, {},
            'In-progress message (empty finish) should not accumulate tokens');
    });

    test('user role message is ignored for token tracking', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_tt_03', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_tt_03', repoRoot);
        await hooks.event({
            event: makeMessageUpdatedEvent('ses_tt_03', {
                messageId: 'msg_tt_03',
                role: 'user',
                inputTokens: 1000,
                outputTokens: 100,
            }),
        } as any);

        const state = loadState(gitDir);
        assert.deepStrictEqual(state.tokensByModel, {},
            'User role message should not accumulate tokens');
    });

    test('delta tracking: second update same messageId uses delta not additive total', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_tt_04', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_tt_04', repoRoot);

        // First streaming snapshot: 500 output tokens so far
        await hooks.event({
            event: makeMessageUpdatedEvent('ses_tt_04', {
                messageId: 'msg_tt_04',
                inputTokens: 50000,
                outputTokens: 500,
            }),
        } as any);

        // Second snapshot: same messageId, streaming added more — total is now 800
        await hooks.event({
            event: makeMessageUpdatedEvent('ses_tt_04', {
                messageId: 'msg_tt_04',
                inputTokens: 50000,
                outputTokens: 800,
            }),
        } as any);

        const state = loadState(gitDir);
        // Delta tracking: delta1=500, delta2=(800-500)=300, accumulated=800
        // Naive additive (WRONG): 500 + 800 = 1300
        assert.strictEqual(
            state.tokensByModel['claude-sonnet-4-6'].outputTokens,
            800,
            'Delta tracking: accumulated output should be 800, not 1300 (naive sum)'
        );
        assert.strictEqual(
            state.tokensByModel['claude-sonnet-4-6'].inputTokens,
            50000,
            'Input tokens should not double-count (second update delta is 0)'
        );
    });

    test('multi-model session tracks tokens per-model separately', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_tt_05', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_tt_05', repoRoot);

        await hooks.event({
            event: makeMessageUpdatedEvent('ses_tt_05', {
                messageId: 'msg_tt_05a',
                modelId: 'claude-sonnet-4-6',
                inputTokens: 10000,
                outputTokens: 200,
            }),
        } as any);

        await hooks.event({
            event: makeMessageUpdatedEvent('ses_tt_05', {
                messageId: 'msg_tt_05b',
                modelId: 'gpt-4o-mini',
                inputTokens: 5000,
                outputTokens: 50,
            }),
        } as any);

        const state = loadState(gitDir);
        assert.ok(state.tokensByModel['claude-sonnet-4-6'], 'Should have claude entry');
        assert.ok(state.tokensByModel['gpt-4o-mini'], 'Should have gpt entry');
        assert.strictEqual(state.tokensByModel['claude-sonnet-4-6'].inputTokens, 10000);
        assert.strictEqual(state.tokensByModel['claude-sonnet-4-6'].outputTokens, 200);
        assert.strictEqual(state.tokensByModel['gpt-4o-mini'].inputTokens, 5000);
        assert.strictEqual(state.tokensByModel['gpt-4o-mini'].outputTokens, 50);
    });
});

// ─── Suite: Inline flag merge ─────────────────────────────────────────────────

suite('OpenCode Plugin — Inline flag merge', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let hooks: any;

    setup(async () => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');
        hooks = await AIContributionTracker(makeMockPluginInput(repoRoot) as any);
    });

    teardown(() => {
        try {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        } catch {}
    });

    test('existing Inline flag merged with agent session data', async () => {
        // Simulate inline tracking already wrote the flag (e.g. from VS Code inline completion)
        const flagPath = getFlagPath(gitDir);
        fs.writeFileSync(flagPath, 'Impacted by AI (Inline)');

        // Start agent session
        await hooks.event({ event: makeSessionCreatedEvent('ses_il_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_il_01', repoRoot);

        await hooks['chat.message'](makeChatMessageInput('ses_il_01', 'build', 'claude-sonnet-4-6'), null);

        const flagContent = fs.readFileSync(flagPath, 'utf8');
        assert.ok(flagContent.includes('Inline'), 'Flag should preserve Inline marker');
        assert.ok(
            flagContent.includes('Agent mode: opencode/build'),
            `Flag should include agent mode, got: ${flagContent}`
        );
    });
});

// ─── Suite: consumed marker (commit boundary detection) ──────────────────────

suite('OpenCode Plugin — consumed marker (commit boundary)', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let hooks: any;

    setup(async () => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');
        hooks = await AIContributionTracker(makeMockPluginInput(repoRoot) as any);
    });

    teardown(() => {
        try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
    });

    test('session.idle does NOT recreate flag after consumed marker is present', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_consumed_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_consumed_01', repoRoot);
        await hooks['chat.message'](makeChatMessageInput('ses_consumed_01'), null);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag should exist before commit');

        const consumedPath = path.join(gitDir, 'AI_IMPACT_CONSUMED');
        fs.writeFileSync(consumedPath, '');
        fs.unlinkSync(flagPath);
        try { fs.unlinkSync(getStatePath(gitDir)); } catch {}

        await hooks.event({ event: makeSessionIdleEvent('ses_consumed_01') } as any);

        assert.ok(!fs.existsSync(flagPath), 'Flag must NOT be recreated after consumed marker');
        assert.ok(!fs.existsSync(consumedPath), 'Consumed marker should be deleted by plugin');
    });

    test('message.updated does NOT recreate flag after consumed marker', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_consumed_02', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_consumed_02', repoRoot);

        await hooks.event({
            event: makeMessageUpdatedEvent('ses_consumed_02', {
                messageId: 'msg_consumed_02',
                inputTokens: 500000,
                outputTokens: 10000,
            }),
        } as any);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag should exist before commit');

        fs.writeFileSync(path.join(gitDir, 'AI_IMPACT_CONSUMED'), '');
        try { fs.unlinkSync(flagPath); } catch {}
        try { fs.unlinkSync(getStatePath(gitDir)); } catch {}

        await hooks.event({
            event: makeMessageUpdatedEvent('ses_consumed_02', {
                messageId: 'msg_consumed_02',
                inputTokens: 510000,
                outputTokens: 10500,
            }),
        } as any);

        assert.ok(!fs.existsSync(flagPath),
            'Flag must NOT be recreated from token streaming after consumed marker');
    });

    test('tool.execute.after (task) does NOT recreate flag after consumed marker', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_consumed_03', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_consumed_03', repoRoot);
        await hooks['chat.message'](makeChatMessageInput('ses_consumed_03'), null);

        fs.writeFileSync(path.join(gitDir, 'AI_IMPACT_CONSUMED'), '');
        try { fs.unlinkSync(getFlagPath(gitDir)); } catch {}
        try { fs.unlinkSync(getStatePath(gitDir)); } catch {}

        await hooks['tool.execute.after']({
            sessionID: 'ses_consumed_03',
            tool: 'task',
            callID: 'call_consumed_03',
            args: { subagent_type: 'explore' },
        } as any, null);

        assert.ok(!fs.existsSync(getFlagPath(gitDir)),
            'Flag must NOT be recreated from task event after consumed marker');
    });

    test('chat.message un-consumes session and starts fresh state', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_consumed_04', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_consumed_04', repoRoot);

        await hooks['chat.message'](makeChatMessageInput('ses_consumed_04', 'build', 'claude-sonnet-4-6'), null);

        fs.writeFileSync(path.join(gitDir, 'AI_IMPACT_CONSUMED'), '');
        try { fs.unlinkSync(getFlagPath(gitDir)); } catch {}
        try { fs.unlinkSync(getStatePath(gitDir)); } catch {}

        await hooks['chat.message'](makeChatMessageInput('ses_consumed_04', 'build', 'gpt-4o'), null);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag should be written for new prompt after consumed');

        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 1,
            'Fresh state should have promptCount=1, not carried over from previous cycle');
        assert.ok(state.models.includes('gpt-4o'), 'New model should be recorded');
        assert.ok(!state.models.includes('claude-sonnet-4-6'),
            'Old model from consumed cycle should NOT be in fresh state');
    });

    test('post-commit prompts survive consumed marker at gitDir resolution', async () => {
        // Scenario: plugin restarts, consumed marker exists, user sends prompts
        // before gitDir is resolved. Those prompts are post-commit and must survive.
        await hooks.event({ event: makeSessionCreatedEvent('ses_consumed_05', 'build') } as any);

        await hooks['chat.message'](makeChatMessageInput('ses_consumed_05', 'build', 'claude-sonnet-4-6'), null);
        await hooks['chat.message'](makeChatMessageInput('ses_consumed_05', 'build', 'claude-sonnet-4-6'), null);

        fs.writeFileSync(path.join(gitDir, 'AI_IMPACT_CONSUMED'), '');

        await triggerGitDirResolution(hooks, 'ses_consumed_05', repoRoot);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath),
            'Post-commit prompts should be flushed (they arrived after the commit)');
        const state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 2,
            'Both post-commit prompts should be counted');
    });

    test('marker format unchanged — regression test', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_fmt_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_fmt_01', repoRoot);

        await hooks['chat.message'](makeChatMessageInput('ses_fmt_01', 'build', 'claude-sonnet-4-6'), null);
        await hooks.event({
            event: makeMessageUpdatedEvent('ses_fmt_01', {
                messageId: 'msg_fmt_01',
                inputTokens: 50000,
                outputTokens: 633,
                cachedTokens: 45000,
            }),
        } as any);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath), 'Flag should exist');
        const content = fs.readFileSync(flagPath, 'utf8');

        assert.ok(content.startsWith('Impacted by AI ('), `Should start with 'Impacted by AI (', got: ${content}`);
        assert.ok(content.includes('Agent mode: opencode/build'), 'Should include agent mode');
        assert.ok(content.includes('Model: claude-sonnet-4-6'), 'Should include model');
        assert.ok(content.includes('Prompts: 1'), 'Should include prompt count');
        assert.ok(content.includes('Tokens:'), 'Should include tokens section');
        assert.ok(content.includes('95k in/633 out'), 'Should format tokens as Nk in/N out');
        assert.ok(content.includes('45k cached'), 'Should include cached tokens');
    });

    test('multiple commits: each cycle only tracks its own AI activity', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_multi_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_multi_01', repoRoot);

        await hooks['chat.message'](makeChatMessageInput('ses_multi_01', 'build', 'claude-sonnet-4-6'), null);
        await hooks['chat.message'](makeChatMessageInput('ses_multi_01', 'build', 'claude-sonnet-4-6'), null);
        await hooks['chat.message'](makeChatMessageInput('ses_multi_01', 'build', 'claude-sonnet-4-6'), null);

        let state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 3, 'Cycle 1 should have 3 prompts');

        fs.writeFileSync(path.join(gitDir, 'AI_IMPACT_CONSUMED'), '');
        try { fs.unlinkSync(getFlagPath(gitDir)); } catch {}
        try { fs.unlinkSync(getStatePath(gitDir)); } catch {}

        await hooks['chat.message'](makeChatMessageInput('ses_multi_01', 'build', 'gpt-4o'), null);

        state = loadState(gitDir);
        assert.strictEqual(state.promptCount, 1,
            'Cycle 2 should have only 1 prompt, not 4 (carried from cycle 1)');
        assert.ok(!state.models.includes('claude-sonnet-4-6'),
            'Cycle 2 should not carry claude model from cycle 1');
        assert.ok(state.models.includes('gpt-4o'),
            'Cycle 2 should have gpt-4o model');
    });
});

// ─── Suite: subagent flag writing ────────────────────────────────────────────

suite('OpenCode Plugin — subagent flag writing', function () {
    this.timeout(10000);

    let repoRoot: string;
    let gitDir: string;
    let hooks: any;

    setup(async () => {
        repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-test-'));
        runGit(['init'], repoRoot);
        runGit(['config', 'user.email', '"test@example.com"'], repoRoot);
        runGit(['config', 'user.name', '"Test User"'], repoRoot);
        gitDir = path.join(repoRoot, '.git');
        hooks = await AIContributionTracker(makeMockPluginInput(repoRoot) as any);
    });

    teardown(() => {
        try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
    });

    test('subagent resolves gitDir and writes flag when main session has state', async () => {
        // Main session writes state
        await hooks.event({ event: makeSessionCreatedEvent('ses_sa_01', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_sa_01', repoRoot);
        await hooks['chat.message'](makeChatMessageInput('ses_sa_01', 'build', 'claude-sonnet-4-6'), null);

        // Subagent session created
        await hooks.event({ event: makeSessionCreatedEvent('ses_sa_01_sub', 'git-master', 'ses_sa_01') } as any);

        // Subagent touches a file — should resolve gitDir and ensure flag exists
        const testFile = path.join(repoRoot, 'subagent-file.ts');
        fs.writeFileSync(testFile, 'export {};\n');
        await hooks['tool.execute.after']({
            sessionID: 'ses_sa_01_sub',
            tool: 'write',
            callID: 'call_sa_01',
            args: { filePath: testFile },
        } as any, null);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath),
            'Flag should exist after subagent resolves gitDir (main session has state)');
    });

    test('subagent writes minimal flag when no main session state exists', async () => {
        // Subagent created WITHOUT main session having written state
        await hooks.event({ event: makeSessionCreatedEvent('ses_sa_02_sub', 'quick', 'ses_sa_02_parent') } as any);

        const testFile = path.join(repoRoot, 'subagent-only.ts');
        fs.writeFileSync(testFile, 'export {};\n');
        await hooks['tool.execute.after']({
            sessionID: 'ses_sa_02_sub',
            tool: 'write',
            callID: 'call_sa_02',
            args: { filePath: testFile },
        } as any, null);

        const flagPath = getFlagPath(gitDir);
        assert.ok(fs.existsSync(flagPath),
            'Flag should exist even without main session state');
        const content = fs.readFileSync(flagPath, 'utf8');
        assert.ok(content.includes('Impacted by AI'),
            'Minimal flag should contain base marker');
    });

    test('subagent does NOT increment subagentCount (main session only)', async () => {
        await hooks.event({ event: makeSessionCreatedEvent('ses_sa_03', 'build') } as any);
        await triggerGitDirResolution(hooks, 'ses_sa_03', repoRoot);
        await hooks['chat.message'](makeChatMessageInput('ses_sa_03'), null);

        // Subagent session
        await hooks.event({ event: makeSessionCreatedEvent('ses_sa_03_sub', 'explore', 'ses_sa_03') } as any);
        await hooks['tool.execute.after']({
            sessionID: 'ses_sa_03_sub',
            tool: 'task',
            callID: 'call_sa_03',
            args: { subagent_type: 'explore' },
        } as any, null);

        const state = loadState(gitDir);
        assert.strictEqual(state.subagentCount, 0,
            'Subagent session should NOT increment subagentCount (main session only)');
    });
});
