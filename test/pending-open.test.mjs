import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'agent-sessions-pending-test-'));
const bundle = join(directory, 'pending.cjs');
await build({ entryPoints: ['src/pending-open.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
const { offerOpen, claimOpen } = createRequire(import.meta.url)(bundle);
after(() => rm(directory, { recursive: true, force: true }));

const offer = { tool: 'claude', id: 's1', folder: '/home/u/repo', install: 'desktop', at: Date.now() };

test('only a window of the asking install on the session\'s folder takes the hand-off', async () => {
  const file = join(directory, 'a.json');
  await offerOpen(file, offer);
  assert.equal(await claimOpen(file, 'phone', '/home/u/repo'), undefined, 'the phone server never opens what the desktop asked for');
  assert.equal(await claimOpen(file, 'desktop', '/home/u'), undefined, 'a window on another folder would resume nothing');
  assert.deepEqual(await claimOpen(file, 'desktop', '/home/u/repo/'), offer, 'the window on the folder takes it');
  assert.equal(await claimOpen(file, 'desktop', '/home/u/repo'), undefined, 'a hand-off is taken once');
});

test('two windows on the folder racing: exactly one opens it', async () => {
  const file = join(directory, 'b.json');
  await offerOpen(file, offer);
  const got = await Promise.all([claimOpen(file, 'desktop', '/home/u/repo'), claimOpen(file, 'desktop', '/home/u/repo')]);
  assert.equal(got.filter(Boolean).length, 1, 'the claim is a rename only one window can win');
});

test('a hand-off no window took in time is ignored', async () => {
  const file = join(directory, 'c.json');
  await offerOpen(file, { ...offer, at: Date.now() - 120_000 });
  assert.equal(await claimOpen(file, 'desktop', '/home/u/repo'), undefined, 'a window opened on the folder later must not pop an old session');
});
