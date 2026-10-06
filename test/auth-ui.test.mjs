import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
const dir = await mkdtemp(join(tmpdir(), 'auth-ui-'));
const credentials = id => ({ tokens: { account_id: id, access_token: 'new', refresh_token: 'new-refresh' } });
let loginId = 'saved';
let terminalOptions;
const messages = [];
globalThis.__authVSCode = {
  extensions: { getExtension: () => undefined },
  window: {
    createTerminal: options => {
      terminalOptions = options;
      return { show() {
        setTimeout(() => void writeFile(join(options.env.CODEX_HOME, 'auth.json'), JSON.stringify(credentials(loginId))), 20);
      } };
    },
    onDidCloseTerminal: () => ({ dispose() {} }),
    showInformationMessage: async message => messages.push(message),
  },
};
const bundle = join(dir, 'auth.cjs');
await build({ entryPoints: ['src/auth-ui.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['node:sqlite'], plugins: [{ name: 'vscode', setup(b) {
 b.onResolve({filter:/^vscode$/},()=>({path:'vscode',namespace:'stub'}));
 b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'module.exports = globalThis.__authVSCode;'}));
} }] });
const { signInCodexAccount } = createRequire(import.meta.url)(bundle);
after(()=>rm(dir,{recursive:true,force:true}));

test('device login imports its watched result, refreshes usage and cleans its isolated home without switching', { timeout: 5000 }, async () => {
 const home = await mkdtemp(join(dir,'case-'));
 const original = JSON.stringify(credentials('active'));
 await writeFile(join(home,'auth.json'),original);
 let refreshed = 0;
 await signInCodexAccount(home,{accountId:'saved',email:'saved@example.com'},async()=>{refreshed++;});
 assert.equal(refreshed,1);
 assert.ok(terminalOptions.shellArgs.includes('--device-auth'));
 assert.notEqual(terminalOptions.env.CODEX_HOME,home);
 assert.equal(await readFile(join(home,'auth.json'),'utf8'),original);
 assert.deepEqual(await readdir(join(home,'auth-profiles')),['saved.json']);
 assert.match(messages.at(-1),/Usage has been refreshed/);
});

test('sign-in to the wrong account reports the error and releases the pending sign-in for retry', { timeout: 5000 }, async () => {
 const home = await mkdtemp(join(dir,'case-'));
 loginId='wrong';
 await assert.rejects(signInCodexAccount(home,{accountId:'saved'},async()=>assert.fail('wrong account')),/different ChatGPT account/);
 assert.deepEqual(await readdir(join(home,'auth-profiles')),[]);
 loginId='saved';
 await signInCodexAccount(home,{accountId:'saved'},async()=>{});
 assert.deepEqual(await readdir(join(home,'auth-profiles')),['saved.json']);
});
