import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { lock } from 'proper-lockfile';
import { readJsonFile } from './util.js';

interface UsageCache {
  data?: unknown;
  asOf: number;
  nextFetchAt: number;
  failures: number;
  error?: string;
}

async function readCache(file: string): Promise<UsageCache | undefined> {
  const value = await readJsonFile<unknown>(file);
  if (!value || typeof value !== 'object'
    || !('asOf' in value) || typeof value.asOf !== 'number' || !Number.isFinite(value.asOf)
    || !('nextFetchAt' in value) || typeof value.nextFetchAt !== 'number' || !Number.isFinite(value.nextFetchAt)
    || !('failures' in value) || typeof value.failures !== 'number' || !Number.isFinite(value.failures)) return undefined;
  return {
    asOf: value.asOf, nextFetchAt: value.nextFetchAt, failures: value.failures,
    ...('data' in value ? { data: value.data } : {}),
    ...('error' in value && typeof value.error === 'string' ? { error: value.error } : {}),
  };
}

async function writeCache(file: string, value: UsageCache): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function cachedClaudeUsage(
  directory: string,
  token: string,
  interval: number,
  request: () => Promise<Response>,
  accountKey?: string,
): Promise<UsageCache> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const cacheFile = (key: string) => path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  const file = cacheFile(accountKey ? `account:${accountKey}` : token);
  const previousCache = async () => await readCache(file) ?? (accountKey ? await readCache(cacheFile(token)) : undefined);
  const cached = await readCache(file);
  if (cached && cached.nextFetchAt > Date.now()) return cached;
  let release: () => Promise<void>;
  try {
    release = await lock(file, { realpath: false, stale: 30_000, retries: { retries: 4, minTimeout: 100, maxTimeout: 500 } });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED') {
      return await previousCache() ?? { asOf: 0, nextFetchAt: 0, failures: 0, error: 'Usage is being refreshed in another window' };
    }
    throw error;
  }
  try {
    const previous = await previousCache();
    if (previous && previous.nextFetchAt > Date.now()) {
      await writeCache(file, previous);
      return previous;
    }
    let next: UsageCache;
    try {
      const response = await request();
      const now = Date.now();
      if (response.ok) {
        const data: unknown = await response.json();
        next = { data, asOf: now, nextFetchAt: now + interval, failures: 0 };
      } else {
        const failures = (previous?.failures ?? 0) + 1;
        const header = response.headers.get('retry-after');
        const retryAt = header === null ? 0 : Number.isFinite(Number(header)) ? now + Number(header) * 1000 : Date.parse(header);
        const backoff = response.status === 429 ? Math.min(3_600_000, 300_000 * 2 ** Math.min(failures - 1, 4)) : interval;
        const nextFetchAt = Math.max(now + backoff, Number.isFinite(retryAt) ? retryAt : 0);
        next = {
          ...previous, asOf: previous?.asOf ?? 0, failures, nextFetchAt,
          error: `Usage endpoint answered ${response.status}; retry after ${new Date(nextFetchAt).toLocaleTimeString()}`,
        };
      }
    } catch (error) {
      next = {
        ...previous, asOf: previous?.asOf ?? 0, failures: (previous?.failures ?? 0) + 1,
        nextFetchAt: Date.now() + interval,
        error: `Usage request failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    await writeCache(file, next);
    return next;
  } finally {
    await release();
  }
}
