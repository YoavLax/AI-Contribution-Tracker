const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				if (location) {
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				}
			});
			console.log('[watch] build finished');
		});
	},
};

async function main() {
	const sharedOptions = {
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		logLevel: 'silent',
		plugins: [esbuildProblemMatcherPlugin],
	};

	// Main extension bundle
	const extCtx = await esbuild.context({
		...sharedOptions,
		entryPoints: ['src/extension.ts'],
		outfile: 'dist/extension.js',
		external: ['vscode'],
	});

	// Hook handler - standalone Node.js script (no vscode dependency)
	const hookCtx = await esbuild.context({
		...sharedOptions,
		entryPoints: ['src/hook-handler.ts'],
		outfile: 'dist/hook-handler.js',
		// bun:sqlite is only require()'d at runtime under the Bun-compiled binary;
		// keep it external so the Node build doesn't try to resolve it.
		external: ['bun:sqlite'],
	});

	// OpenCode plugin - ESM format (matches OpenCode plugin loader)
	const openCodeCtx = await esbuild.context({
		...sharedOptions,
		entryPoints: ['src/opencode-plugin.ts'],
		outfile: 'dist/opencode-plugin.js',
		external: [], format: 'esm',
	});

	if (watch) {
		await Promise.all([extCtx.watch(), hookCtx.watch(), openCodeCtx.watch()]);
	} else {
		const results = await Promise.allSettled([extCtx.rebuild(), hookCtx.rebuild(), openCodeCtx.rebuild()]);
		await Promise.all([extCtx.dispose(), hookCtx.dispose(), openCodeCtx.dispose()]);
		const failed = results.find((result) => result.status === 'rejected');
		if (failed) {
			throw failed.reason;
		}
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
