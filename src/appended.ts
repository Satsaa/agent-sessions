import * as fsp from 'node:fs/promises';

/**
 * Where a scan of an append-only JSONL file stopped. Transcripts and rollouts only grow while a session runs, often
 * to tens or hundreds of MB, and a busy one is appended to many times a second, so a changed file is read on from
 * `offset` rather than from its first byte again, unless the bytes before `offset` changed: then it was rewritten,
 * and it is read whole.
 */
export interface Scan {
  /** The end of the last complete line read. */
  offset: number;
  /** The bytes just before `offset`, base64. */
  tail: string;
}

const TAIL_BYTES = 256;

async function tailAt(fh: fsp.FileHandle, offset: number): Promise<string> {
  const length = Math.min(TAIL_BYTES, offset);
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset - length);
  return buf.subarray(0, bytesRead).toString('base64');
}

/** Feeds `read` each complete line after `previous` (a copy of it), or every line when `previous` no longer fits. */
export async function scanAppended<T extends Scan>(file: string, size: number, previous: T | undefined, fresh: () => T, read: (scan: T, line: string) => void): Promise<T> {
  const fh = await fsp.open(file, 'r');
  try {
    const appended = previous && previous.offset > 0 && previous.offset <= size && (await tailAt(fh, previous.offset)) === previous.tail;
    const scan = appended ? { ...previous } : fresh();
    let partial: Buffer[] = [];
    let consumed = 0;
    for await (const chunk of fh.createReadStream({ start: scan.offset, autoClose: false }) as AsyncIterable<Buffer>) {
      let start = 0;
      for (let nl = chunk.indexOf(0x0a); nl !== -1; nl = chunk.indexOf(0x0a, start)) {
        const piece = chunk.subarray(start, nl);
        const line = partial.length ? Buffer.concat([...partial, piece]) : piece;
        partial = [];
        consumed += line.length + 1;
        const text = line.toString('utf8').trim();
        if (text) read(scan, text);
        start = nl + 1;
      }
      // A line still being written is read once it ends.
      if (start < chunk.length) partial.push(chunk.subarray(start));
    }
    scan.offset += consumed;
    scan.tail = await tailAt(fh, scan.offset);
    return scan;
  } finally {
    await fh.close();
  }
}
