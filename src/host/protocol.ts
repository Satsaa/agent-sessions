import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The session host keeps Claude Code processes alive outside any VS Code window. The Claude extension's
 * `claudeCode.claudeProcessWrapper` setting points at our wrapper, which the panel starts in place of `claude`; the
 * wrapper hands the command line to the host over a Unix socket and relays the panel's stream-json both ways. Closing
 * the window, a sleeping phone or a server restart only drops the wrapper; the host keeps a busy turn running, and the
 * next panel to open the session reconnects to it instead of starting a second process on the same conversation.
 *
 * Bump `PROTOCOL` whenever a message below changes shape: a wrapper and a host from different extension versions
 * refuse each other, and the wrapper then runs `claude` directly for that session.
 */
export const PROTOCOL = 1;

/** Set in the environment of a VS Code server to name its windows to the person; see `ClientIdentity.label`. */
export const CLIENT_LABEL_ENV = 'AGENT_SESSIONS_CLIENT';
export const DEFAULT_CLIENT_LABEL = 'another VS Code window';

export function hostDir(): string {
  return path.join(os.homedir(), '.agent-sessions', 'host');
}

export function socketPath(dir = hostDir()): string {
  return path.join(dir, 'host.sock');
}

/**
 * Who holds a session. `label` completes "This session is running in …" ("the phone view"); `ownerPid` is the
 * extension host that started the wrapper, which tells one window from another.
 */
export interface ClientIdentity {
  label: string;
  ownerPid: number;
}

/** First line a wrapper sends; every later line from it is the panel's stdin, verbatim. */
export interface AttachRequest {
  op: 'attach';
  protocol: number;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  client: ClientIdentity;
}

export interface StatusRequest {
  op: 'status';
  protocol: number;
}

/** Lets the next attach to `sessionId` move it away from the window holding it. */
export interface TakeoverRequest {
  op: 'allow-takeover';
  protocol: number;
  sessionId: string;
}

export interface StopRequest {
  op: 'stop';
  protocol: number;
  sessionId: string;
}

export type HostRequest = AttachRequest | StatusRequest | TakeoverRequest | StopRequest;

export type SessionState = 'busy' | 'waiting' | 'idle';

export interface HostedSession {
  sessionId: string | undefined;
  pid: number | undefined;
  state: SessionState;
  holder: ClientIdentity | undefined;
}

/** Lines the host sends a wrapper: the process's stdout and stderr, and what happened to the attachment. */
export type HostMessage =
  | { o: string }
  | { e: string }
  | { ev: 'attached' }
  | { ev: 'refused'; message: string }
  | { ev: 'moved'; to: string }
  | { ev: 'exit'; code: number | null; signal: string | null }
  | { ev: 'status'; sessions: HostedSession[] }
  | { ev: 'ok' }
  | { ev: 'error'; message: string };

/** The conversation a command line continues, when it names one; `--fork-session` starts a new one. */
export function resumedSessionId(argv: readonly string[]): string | undefined {
  if (argv.includes('--fork-session')) return undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    for (const flag of ['--resume', '-r', '--session-id']) {
      if (a === flag) return argv[i + 1];
      if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
    }
  }
  return undefined;
}

/** Only a panel conversation goes through the host; `claude auth status` and the like run directly. */
export function isPanelSession(argv: readonly string[]): boolean {
  const i = argv.indexOf('--input-format');
  return (i >= 0 && argv[i + 1] === 'stream-json') || argv.includes('--input-format=stream-json');
}

/** Splits a byte stream into lines, keeping a partial last line until its newline arrives. */
export function lineReader(onLine: (line: string) => void): (chunk: Buffer | string) => void {
  let rest = '';
  return (chunk) => {
    rest += chunk.toString();
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (line.length > 0) onLine(line);
    }
  };
}
