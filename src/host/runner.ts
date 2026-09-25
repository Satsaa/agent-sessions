import { execFile } from 'node:child_process';
import type { RunRequest, RunResult } from '../runner.js';

/**
 * Runs the extension's commands (git, for the worktree stats) on its behalf. Starting a process forks the one that
 * starts it, and forking the extension host — hundreds of megabytes, partly swapped out on a busy machine — stalls
 * its thread for as long as the copy takes, and every other extension's with it. This process is small, so its forks
 * are cheap; it is started once and ends with the extension host.
 */
process.on('message', (request: RunRequest) => {
  execFile(request.file, request.args, { cwd: request.cwd, timeout: request.timeoutMs, maxBuffer: request.maxBuffer }, (err, stdout) => {
    const result: RunResult = err ? { id: request.id } : { id: request.id, stdout };
    process.send?.(result);
  });
});
process.on('disconnect', () => process.exit(0));
