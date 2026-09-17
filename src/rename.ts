import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Session } from './types.js';
import { customTitleFile } from './claude.js';
import { loadSqlite, newestDb } from './codex.js';

/** Append one JSON line, starting a fresh line if the file's last byte is not a newline (a crash can leave a partial line). */
async function appendJsonLine(file: string, record: unknown): Promise<void> {
  let needsNewline = false;
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      if (size > 0) {
        const buf = Buffer.alloc(1);
        await fh.read(buf, 0, 1, size - 1);
        needsNewline = buf[0] !== 0x0a;
      }
    } finally {
      await fh.close();
    }
  } catch {
    // Missing file: created by the append below.
  }
  await fsp.appendFile(file, `${needsNewline ? '\n' : ''}${JSON.stringify(record)}\n`);
}

/**
 * Give a session the title its own tool would write for `/rename`, so the tool and this view read the same name.
 * Claude Code writes `<id>/custom-title.json` beside the transcript and appends a `custom-title` record to it;
 * Codex sets `threads.title` in its state database and appends `{id, thread_name}` to `session_index.jsonl`.
 * The logs are append-only with the last record winning, so nothing the tool may be writing is rewritten.
 */
export async function renameSession(session: Session, codexHome: string, title: string): Promise<void> {
  const name = title.trim();
  if (!name) throw new Error('A title cannot be empty.');
  if (session.tool === 'claude') {
    const sidecar = customTitleFile(session.transcriptPath, session.id);
    await fsp.mkdir(path.dirname(sidecar), { recursive: true });
    await fsp.writeFile(sidecar, JSON.stringify({ customTitle: name }));
    await appendJsonLine(session.transcriptPath, { type: 'custom-title', customTitle: name, sessionId: session.id });
    return;
  }
  await appendJsonLine(path.join(codexHome, 'session_index.jsonl'), { id: session.id, thread_name: name, updated_at: new Date().toISOString() });
  const mod = loadSqlite();
  const stateFile = mod ? await newestDb(codexHome, 'state') : undefined;
  if (!mod || !stateFile) return;
  // Codex's own title column is what its sidebar and tab show; WAL mode lets this short write coexist with a running Codex.
  const db = new mod.DatabaseSync(stateFile);
  try {
    db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(name, session.id);
  } finally {
    db.close();
  }
}
