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
		external: [],
	});

	if (watch) {
		await Promise.all([extCtx.watch(), hookCtx.watch()]);
	} else {
		await Promise.all([extCtx.rebuild(), hookCtx.rebuild()]);
		await Promise.all([extCtx.dispose(), hookCtx.dispose()]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
