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
  external: ['vscode', 'node:sqlite'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

/**
 * The session host and the wrapper Claude Code starts in place of `claude` run as plain Node programs, outside the
 * extension host (see src/host/protocol.ts).
 */
/** @type {esbuild.BuildOptions} */
const hostOptions = {
  entryPoints: { 'claude-wrapper': 'src/host/wrapper.ts', 'session-host': 'src/host/host-main.ts' },
  bundle: true,
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  platform: 'node',
  target: 'node22',
  format: 'esm',
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
