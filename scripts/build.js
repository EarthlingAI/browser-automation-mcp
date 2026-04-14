#!/usr/bin/env node

/**
 * Production build for Earthling Browser Automation MCP.
 *
 * Bundles the TypeScript source into a single dist/index.js with all
 * vendored dependencies inlined. playwright-core stays external (client API).
 */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

// Plugin: resolve any require('...package.json') to the repo root package.json
const packageJsonPlugin = {
	name: 'package-json-resolver',
	setup(build) {
		build.onResolve({ filter: /package\.json$/ }, args => {
			// Only intercept relative requires from our src/
			if (args.resolveDir.includes(path.join('browser-automation-mcp', 'src')))
				return { path: path.join(repoRoot, 'package.json') };
		});
	},
};

async function build() {
	const result = await esbuild.build({
		entryPoints: {
			'index': path.join(repoRoot, 'dev.ts'),
			'relay-daemon': path.join(repoRoot, 'src', 'tools', 'mcp', 'relay', 'daemon.ts'),
		},
		bundle: true,
		platform: 'node',
		target: 'node18',
		outdir: path.join(repoRoot, 'dist'),
		format: 'cjs',
		external: [
			// Client API — stays as npm dependency
			'playwright-core',
			'playwright',
			// Bidi protocol support (not used in extension mode)
			'chromium-bidi',
			'chromium-bidi/*',
		],
		alias: {
			'@isomorphic': path.join(repoRoot, 'src', 'utils', 'isomorphic'),
			'@utils': path.join(repoRoot, 'src', 'server', 'utils'),
		},
		plugins: [packageJsonPlugin],
		sourcemap: true,
		minify: false,
		metafile: true,
		logLevel: 'warning',
	});

	const text = await esbuild.analyzeMetafile(result.metafile);
	console.log('Build analysis:');
	console.log(text);

	const outSize = (fs.statSync(path.join(repoRoot, 'dist', 'index.js')).size / 1024 / 1024).toFixed(1);
	const relaySize = (fs.statSync(path.join(repoRoot, 'dist', 'relay-daemon.js')).size / 1024 / 1024).toFixed(1);
	console.log(`\nBuild complete: dist/index.js (${outSize} MB), dist/relay-daemon.js (${relaySize} MB)`);
}

build().catch(err => {
	console.error('Build failed:', err);
	process.exit(1);
});
