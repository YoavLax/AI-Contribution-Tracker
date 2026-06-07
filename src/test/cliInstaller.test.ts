/**
 * Tests for packages/opencode-plugin/cli.js
 *
 * The CLI is a self-executing Node.js script (no exports) so every test
 * spawns it as a subprocess.  Filesystem isolation is achieved by:
 *   1. Pointing HOME / USERPROFILE to a per-test temp directory so that
 *      os.homedir() returns the temp dir inside the child process.
 *   2. Pointing GIT_CONFIG_GLOBAL to a temp gitconfig file so that
 *      `git config --global` reads/writes never touch the real system config.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';

const CLI_PATH = path.resolve(__dirname, '../../packages/opencode-plugin/cli.js');
const PLUGIN_NAME = '@rachel_rotenberg/ai-contribution-tracker';
const HOOK_BEGIN = '# BEGIN ai-contribution-tracker-cli';
const HOOK_END = '# END ai-contribution-tracker-cli';

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface CliResult { stdout: string; stderr: string; status: number; }

function runCli(args: string[], envOverrides: Record<string, string | undefined> = {}): CliResult {
    const result = cp.spawnSync(process.execPath, [CLI_PATH, ...args], {
        encoding: 'utf8',
        env: { ...process.env, ...envOverrides },
    });
    return {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
        status: result.status ?? 0,
    };
}

/** Create an isolated temp home dir and a matching git global config file. */
function makeTempHome(): { homeDir: string; gitConfig: string; cleanup: () => void } {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-home-'));
    const gitConfig = path.join(homeDir, '.gitconfig');
    fs.writeFileSync(gitConfig, '[user]\n\temail = test@example.com\n\tname = Test\n');
    return {
        homeDir,
        gitConfig,
        cleanup: () => { try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ } },
    };
}

/** Build a child-process env that isolates filesystem and git global config. */
function cliEnv(
    homeDir: string,
    gitConfig: string,
    extra: Record<string, string> = {}
): Record<string, string | undefined> {
    return { HOME: homeDir, USERPROFILE: homeDir, GIT_CONFIG_GLOBAL: gitConfig, ...extra };
}

/** Default hook + plugin paths for a given homeDir. */
function defaultPaths(homeDir: string) {
    const hooksDir = path.join(homeDir, '.config', 'ai-contribution-tracker', 'git-hooks');
    const hookFile = path.join(hooksDir, 'commit-msg');
    const opencodeConfig = path.join(homeDir, '.config', 'opencode', 'opencode.json');
    return { hooksDir, hookFile, opencodeConfig };
}

// ─── Suite: init command ──────────────────────────────────────────────────────

suite('CLI Installer — init', function () {
    this.timeout(15000);

    let homeDir: string;
    let gitConfig: string;
    let cleanup: () => void;

    setup(() => {
        ({ homeDir, gitConfig, cleanup } = makeTempHome());
    });
    teardown(() => cleanup());

    test('init creates hook and plugin config from scratch', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { status, stdout } = runCli(['init'], env);

        assert.strictEqual(status, 0, `CLI exited with ${status}`);

        const { hookFile, opencodeConfig } = defaultPaths(homeDir);
        assert.ok(fs.existsSync(hookFile), 'commit-msg hook should be created');
        const hookContent = fs.readFileSync(hookFile, 'utf8');
        assert.ok(hookContent.includes(HOOK_BEGIN), 'Hook should contain tracker snippet');
        assert.ok(hookContent.startsWith('#!/bin/sh'), 'New hook should start with shebang');

        assert.ok(fs.existsSync(opencodeConfig), 'opencode.json should be created');
        const config = JSON.parse(fs.readFileSync(opencodeConfig, 'utf8'));
        assert.ok(Array.isArray(config.plugin), 'plugin field should be an array');
        assert.ok(
            config.plugin.includes(PLUGIN_NAME),
            `${PLUGIN_NAME} should be in plugin array`
        );

        assert.ok(stdout.includes('Done'), 'Output should confirm completion');
    });

    test('init sets core.hooksPath in global git config', () => {
        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);

        const configContent = fs.readFileSync(gitConfig, 'utf8');
        assert.ok(configContent.includes('hooksPath'), 'Global gitconfig should have hooksPath set');
    });

    test('init is idempotent — skips already-installed hook snippet', () => {
        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);           // first run installs
        const { stdout } = runCli(['init'], env);  // second run should skip

        assert.ok(
            stdout.includes('already has AI tracker snippet') || stdout.includes('already'),
            `Expected skip message on second run, got: ${stdout}`
        );
    });

    test('init is idempotent — skips already-registered plugin', () => {
        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);
        const { stdout } = runCli(['init'], env);

        assert.ok(
            stdout.includes('Plugin already in'),
            `Expected "Plugin already in" on second run, got: ${stdout}`
        );
    });

    test('init appends snippet to an existing commit-msg hook', () => {
        // Pre-create a hook file with unrelated content at the core.hooksPath location
        const customHooksDir = path.join(homeDir, 'custom-hooks');
        fs.mkdirSync(customHooksDir, { recursive: true });
        const existingHookPath = path.join(customHooksDir, 'commit-msg');
        const preExistingContent = '#!/bin/sh\necho "existing hook"\n';
        fs.writeFileSync(existingHookPath, preExistingContent);

        // Point global git config to that hooks dir
        fs.writeFileSync(
            gitConfig,
            `[user]\n\temail = test@example.com\n\tname = Test\n[core]\n\thooksPath = ${customHooksDir.replace(/\\/g, '/')}\n`
        );

        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);

        const updatedContent = fs.readFileSync(existingHookPath, 'utf8');
        assert.ok(updatedContent.includes('existing hook'), 'Pre-existing hook content should be preserved');
        assert.ok(updatedContent.includes(HOOK_BEGIN), 'AI tracker snippet should be appended');
    });
});

// ─── Suite: status command ────────────────────────────────────────────────────

suite('CLI Installer — status', function () {
    this.timeout(15000);

    let homeDir: string;
    let gitConfig: string;
    let cleanup: () => void;

    setup(() => {
        ({ homeDir, gitConfig, cleanup } = makeTempHome());
    });
    teardown(() => cleanup());

    test('status shows installed markers after init', () => {
        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);
        const { stdout, status } = runCli(['status'], env);

        assert.strictEqual(status, 0);
        // Both ✔ markers for hook and plugin
        const checkCount = (stdout.match(/✓/g) || []).length;
        assert.ok(checkCount >= 2, `Expected at least 2 ✓ markers, stdout:\n${stdout}`);
    });

    test('status shows warning when nothing is installed', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { stdout, status } = runCli(['status'], env);

        assert.strictEqual(status, 0);
        // Should contain at least one warning marker
        assert.ok(
            stdout.includes('!') || stdout.includes('No global core.hooksPath'),
            `Expected warning markers, stdout:\n${stdout}`
        );
    });
});

// ─── Suite: remove command ────────────────────────────────────────────────────

suite('CLI Installer — remove', function () {
    this.timeout(15000);

    let homeDir: string;
    let gitConfig: string;
    let cleanup: () => void;

    setup(() => {
        ({ homeDir, gitConfig, cleanup } = makeTempHome());
    });
    teardown(() => cleanup());

    test('remove uninstalls hook and plugin', () => {
        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);

        const { hooksDir, hookFile, opencodeConfig } = defaultPaths(homeDir);
        assert.ok(fs.existsSync(hookFile), 'Hook must exist before remove');

        const { status } = runCli(['remove'], env);
        assert.strictEqual(status, 0);

        // Hook file deleted (it contained only our snippet)
        assert.ok(!fs.existsSync(hookFile), 'Hook file should be deleted after remove');

        // Plugin removed from opencode.json
        assert.ok(fs.existsSync(opencodeConfig), 'opencode.json should still exist after remove');
        const config = JSON.parse(fs.readFileSync(opencodeConfig, 'utf8'));
        const plugins: unknown[] = Array.isArray(config.plugin) ? config.plugin : [];
        const stillRegistered = plugins.some(
            (p) => p && (typeof p === 'string' ? p : Array.isArray(p) ? p[0] : null) === PLUGIN_NAME
        );
        assert.ok(!stillRegistered, 'Plugin should be removed from opencode.json');
    });

    test('remove preserves non-tracker content in hook', () => {
        // Pre-create hook with our snippet plus extra content
        const customHooksDir = path.join(homeDir, 'custom-hooks');
        fs.mkdirSync(customHooksDir, { recursive: true });
        const hookPath = path.join(customHooksDir, 'commit-msg');
        const otherContent = '#!/bin/sh\necho "other hook logic"\n';
        const fullContent = otherContent + '\n' + HOOK_BEGIN + '\nsome_snippet\n' + HOOK_END + '\n';
        fs.writeFileSync(hookPath, fullContent);

        fs.writeFileSync(
            gitConfig,
            `[user]\n\temail = test@example.com\n\tname = Test\n[core]\n\thooksPath = ${customHooksDir.replace(/\\/g, '/')}\n`
        );

        const env = cliEnv(homeDir, gitConfig);
        runCli(['remove'], env);

        // File should still exist with original content minus our block
        assert.ok(fs.existsSync(hookPath), 'Hook file should survive remove when it has other content');
        const remaining = fs.readFileSync(hookPath, 'utf8');
        assert.ok(remaining.includes('other hook logic'), 'Non-tracker content should be preserved');
        assert.ok(!remaining.includes(HOOK_BEGIN), 'Tracker snippet should be removed');
        assert.ok(!remaining.includes(HOOK_END), 'Tracker snippet end marker should be removed');
    });

    test('remove is safe when nothing is installed', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { status } = runCli(['remove'], env);
        assert.strictEqual(status, 0, 'remove on clean system should exit 0');
    });
});

// ─── Suite: plugin config edge cases ─────────────────────────────────────────

suite('CLI Installer — plugin config edge cases', function () {
    this.timeout(15000);

    let homeDir: string;
    let gitConfig: string;
    let cleanup: () => void;

    setup(() => {
        ({ homeDir, gitConfig, cleanup } = makeTempHome());
    });
    teardown(() => cleanup());

    test('init adds plugin to existing opencode.json with other plugins', () => {
        const opencodeDir = path.join(homeDir, '.config', 'opencode');
        fs.mkdirSync(opencodeDir, { recursive: true });
        const configPath = path.join(opencodeDir, 'opencode.json');
        fs.writeFileSync(configPath, JSON.stringify({ plugin: ['other-plugin'] }, null, 2));

        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.ok(config.plugin.includes('other-plugin'), 'other-plugin should be preserved');
        assert.ok(config.plugin.includes(PLUGIN_NAME), 'Our plugin should be added');
    });

    test('init skips plugin registration when registered as tuple [name, options]', () => {
        const opencodeDir = path.join(homeDir, '.config', 'opencode');
        fs.mkdirSync(opencodeDir, { recursive: true });
        const configPath = path.join(opencodeDir, 'opencode.json');
        fs.writeFileSync(configPath, JSON.stringify({ plugin: [[PLUGIN_NAME, {}]] }, null, 2));

        const env = cliEnv(homeDir, gitConfig);
        const { stdout } = runCli(['init'], env);

        assert.ok(stdout.includes('Plugin already in'), 'Should skip when plugin is a tuple registration');

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.strictEqual(config.plugin.length, 1, 'Should not add a duplicate entry');
    });

    test('init backs up malformed opencode.json and recovers', () => {
        const opencodeDir = path.join(homeDir, '.config', 'opencode');
        fs.mkdirSync(opencodeDir, { recursive: true });
        const configPath = path.join(opencodeDir, 'opencode.json');
        fs.writeFileSync(configPath, '{ this is not valid json }');

        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);

        // Backup should exist
        assert.ok(fs.existsSync(configPath + '.bak'), 'Backup of malformed JSON should be created');

        // New config should be valid and contain our plugin
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.ok(config.plugin.includes(PLUGIN_NAME), 'Plugin should be in recovered config');
    });
});

// ─── Suite: command routing ───────────────────────────────────────────────────

suite('CLI Installer — command routing', function () {
    this.timeout(10000);

    let homeDir: string;
    let gitConfig: string;
    let cleanup: () => void;

    setup(() => {
        ({ homeDir, gitConfig, cleanup } = makeTempHome());
    });
    teardown(() => cleanup());

    test('--help exits 0 and prints usage', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { status, stdout } = runCli(['--help'], env);
        assert.strictEqual(status, 0);
        assert.ok(stdout.includes('Usage:'), 'Help output should include Usage section');
        assert.ok(stdout.includes('init'), 'Help output should list init command');
        assert.ok(stdout.includes('status'), 'Help output should list status command');
        assert.ok(stdout.includes('remove'), 'Help output should list remove command');
    });

    test('help alias exits 0 and prints usage', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { status, stdout } = runCli(['help'], env);
        assert.strictEqual(status, 0);
        assert.ok(stdout.includes('Usage:'));
    });

    test('unknown command exits 1', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { status } = runCli(['bogus-command'], env);
        assert.strictEqual(status, 1, 'Unknown command should exit with code 1');
    });

    test('no command exits 0 and prints usage', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { status, stdout } = runCli([], env);
        assert.strictEqual(status, 0, 'No command should exit 0');
        assert.ok(stdout.includes('Usage:'));
    });

    test('"install" alias works the same as "init"', () => {
        const env = cliEnv(homeDir, gitConfig);
        const { status } = runCli(['install'], env);
        assert.strictEqual(status, 0);
        const { hookFile } = defaultPaths(homeDir);
        assert.ok(fs.existsSync(hookFile), '"install" alias should create hook');
    });

    test('"uninstall" alias works the same as "remove"', () => {
        const env = cliEnv(homeDir, gitConfig);
        runCli(['init'], env);
        const { status } = runCli(['uninstall'], env);
        assert.strictEqual(status, 0);
        const { hookFile } = defaultPaths(homeDir);
        assert.ok(!fs.existsSync(hookFile), '"uninstall" alias should remove hook');
    });
});
