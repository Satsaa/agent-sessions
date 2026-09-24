import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionHost } from './host.js';
import { hostDir, socketPath } from './protocol.js';

const dir = hostDir();
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const logFile = path.join(dir, 'host.log');
const log = (line: string) => fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

const host = new SessionHost({
  socketPath: socketPath(dir),
  idleStopMs: 10 * 60_000,
  emptyExitMs: 10 * 60_000,
  takeoverMs: 60_000,
  log,
});

if (!(await host.listen())) process.exit(0);
log(`host ${process.pid} listening`);
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log(`${signal}: stopping ${host.sessions().length} sessions`);
    void host.close().then(() => process.exit(0));
  });
}
