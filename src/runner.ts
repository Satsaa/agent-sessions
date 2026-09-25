import { execFile, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunRequest {
  id: number;
  file: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  maxBuffer: number;
}

/** A command's standard output, or none when it failed, timed out or could not start. */
export interface RunResult {
  id: number;
  stdout?: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

/** Built next to extension.cjs (see esbuild.mjs); a bundle without it, as in the tests, runs commands itself. */
const RUNNER_SCRIPT = path.join(__dirname, 'runner.mjs');

let runner: ChildProcess | undefined;
let nextId = 0;
const waiting = new Map<number, (stdout: string | undefined) => void>();

function startRunner(): ChildProcess | undefined {
  if (runner) return runner;
  if (!fs.existsSync(RUNNER_SCRIPT)) return undefined;
  const child = spawn(process.execPath, [RUNNER_SCRIPT], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('message', (result: RunResult) => {
    waiting.get(result.id)?.(result.stdout);
    waiting.delete(result.id);
  });
  const gone = () => {
    if (runner !== child) return;
    runner = undefined;
    for (const done of waiting.values()) done(undefined);
    waiting.clear();
  };
  child.on('exit', gone);
  child.on('error', gone);
  // The extension host's lifetime is VS Code's to decide; an idle runner must not hold it open.
  child.unref();
  child.channel?.unref();
  runner = child;
  return child;
}

/**
 * Runs `file` and resolves with its standard output, or undefined when it fails. The command is started by the runner
 * process (src/host/runner.ts), never by the extension host itself, whose thread a fork would stall.
 */
export function run(file: string, args: string[], options: RunOptions = {}): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBuffer = options.maxBuffer ?? 8 * 1024 * 1024;
  const child = startRunner();
  if (!child) {
    return new Promise((resolve) => {
      execFile(file, args, { cwd: options.cwd, timeout: timeoutMs, maxBuffer }, (err, stdout) => resolve(err ? undefined : stdout));
    });
  }
  return new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    const request: RunRequest = { id, file, args, ...(options.cwd ? { cwd: options.cwd } : {}), timeoutMs, maxBuffer };
    child.send(request, (err) => {
      if (!err) return;
      waiting.delete(id);
      resolve(undefined);
    });
  });
}

/** Ends the runner; the next command starts a new one. */
export function stopRunner(): void {
  runner?.kill();
}
