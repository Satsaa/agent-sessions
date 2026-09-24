#!/usr/bin/env node
// Stands in for the Codex extension's bundled binary: logs its arguments to $FAKE_CODEX_LOG, fails `daemon start`,
// and as `app-server` answers every request line with its own name, so a test can tell it from the daemon.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, `${args.join(' ')}\n`);
if (args.includes('daemon')) process.exit(1);
if (!args.includes('app-server')) process.exit(0);
let rest = '';
process.stdin.on('data', (chunk) => {
  rest += chunk;
  let i;
  while ((i = rest.indexOf('\n')) >= 0) {
    const m = JSON.parse(rest.slice(0, i));
    rest = rest.slice(i + 1);
    process.stdout.write(`${JSON.stringify({ id: m.id, result: { from: 'bundled' } })}\n`);
  }
});
process.stdin.on('end', () => process.exit(0));
