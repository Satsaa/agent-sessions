import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.cjs',
  platform: 'node',
  // VS Code 1.105 ships Node 22+; node:sqlite is loaded lazily and guarded at runtime.
  target: 'node22',
  format: 'cjs',
  // ws loads these native speedups when installed and works without them.
  external: ['vscode', 'node:sqlite', 'bufferutil', 'utf-8-validate'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

/**
 * The session host and the wrappers Claude Code and Codex start in place of their binaries run as plain Node
 * programs, outside the extension host (see src/host/protocol.ts and src/host/codex-daemon.ts).
 */
/** @type {esbuild.BuildOptions} */
const hostOptions = {
  entryPoints: { 'claude-wrapper': 'src/host/wrapper.ts', 'codex-wrapper': 'src/host/codex-wrapper.ts', 'session-host': 'src/host/host-main.ts' },
  bundle: true,
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS and requires Node's builtins, which an ES module has no `require` for.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  sourcemap: true,
  logLevel: 'info',
};

if (watch) {
  await (await esbuild.context(options)).watch();
  await (await esbuild.context(hostOptions)).watch();
} else {
  await esbuild.build(options);
  await esbuild.build(hostOptions);
}
