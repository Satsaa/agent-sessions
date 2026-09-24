import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

interface Entry<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

interface Stored<T> {
  version: number;
  entries: Record<string, Entry<T>>;
}

const WRITE_DELAY_MS = 2000;

/**
 * What was read from each transcript, kept in memory and mirrored to `~/.agent-sessions/cache/<name>.json`, so a window
 * starting cold reuses what another window already parsed instead of reading every transcript again: each phone page
 * load is a new extension host, and a cold read of every transcript takes the better part of a minute on a busy machine.
 * An entry holds only while its file's mtime and size are unchanged.
 *
 * `version` names the shape and meaning of the values: bump it whenever the code that computes them changes, or
 * windows keep serving what the old code read.
 */
export class FileCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  /** Files this process has listed; a write keeps only those, so transcripts deleted before it started drop out. */
  private readonly touched = new Set<string>();
  private loading: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly name: string,
    private readonly version: number,
    private readonly dir = path.join(os.homedir(), '.agent-sessions', 'cache'),
  ) {}

  private get file(): string {
    return path.join(this.dir, `${this.name}.json`);
  }

  /** Loads the file once per process; entries already computed here win over it. */
  ready(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const stored = JSON.parse(await fsp.readFile(this.file, 'utf8')) as Stored<T>;
        if (stored?.version !== this.version || !stored.entries) return;
        for (const [file, e] of Object.entries(stored.entries)) if (!this.entries.has(file)) this.entries.set(file, e);
      } catch {
        // Missing or unreadable: every file is read afresh.
      }
    })();
    return this.loading;
  }

  /** The value computed for this exact version of the file. */
  get(file: string, mtimeMs: number, size: number): T | undefined {
    this.touched.add(file);
    const e = this.entries.get(file);
    return e && e.mtimeMs === mtimeMs && e.size === size ? e.value : undefined;
  }

  /** The value computed for an earlier version of the file, for callers that carry an answer forward. */
  previous(file: string): Entry<T> | undefined {
    return this.entries.get(file);
  }

  set(file: string, mtimeMs: number, size: number, value: T): void {
    this.touched.add(file);
    this.entries.set(file, { mtimeMs, size, value });
    this.timer ??= setTimeout(() => void this.write(), WRITE_DELAY_MS);
  }

  private async write(): Promise<void> {
    this.timer = undefined;
    const entries: Record<string, Entry<T>> = {};
    for (const file of this.touched) {
      const e = this.entries.get(file);
      if (e) entries[file] = e;
    }
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      // Written beside and renamed over, so another window never reads half a file.
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ version: this.version, entries } satisfies Stored<T>));
      await fsp.rename(tmp, this.file);
    } catch {
      // A cache that cannot be written only costs the next cold window its head start.
    }
  }
}
