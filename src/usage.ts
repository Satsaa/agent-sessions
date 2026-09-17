import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from './types.js';
import { readJsonFile, walkFiles, statOrUndefined } from './util.js';
import { cachedClaudeUsage } from './claude-usage-cache.js';
import { decodeCodexAuth } from './codex-accounts.js';

export interface UsageWindow {
  /** Short label: "Session (5h)", "Weekly", "Weekly · Opus", "Extra usage". */
  label: string;
  /** 0–100. */
  percent: number;
  resetsAt: number | undefined;
  /** Provider's own severity when it states one. */
  severity: 'normal' | 'warning' | 'critical' | 'locked' | undefined;
  detail: string | undefined;
}

export interface ToolUsage {
  tool: Tool;
  plan: string | undefined;
  /** Which login the numbers belong to (the ChatGPT email for Codex), when known. */
  account: string | undefined;
  windows: UsageWindow[];
  /** When the numbers were true. */
  asOf: number;
  /** How the numbers were obtained, for the tooltip. */
  source: string;
  error: string | undefined;
}

// ---------------------------------------------------------------- Claude

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    expiresAt?: number;
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

interface ClaudeUsageBucket {
  utilization?: number | null;
  resets_at?: string | null;
  locked_reason?: string | null;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageBucket | null;
  seven_day?: ClaudeUsageBucket | null;
  seven_day_opus?: ClaudeUsageBucket | null;
  seven_day_sonnet?: ClaudeUsageBucket | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number | null;
    used_credits?: number | null;
    utilization?: number | null;
    currency?: string | null;
  } | null;
  limits?: {
    kind?: string;
    group?: string;
    percent?: number;
    severity?: string;
    resets_at?: string | null;
    scope?: { model?: { id?: string | null; display_name?: string | null } | null; surface?: string | null } | null;
    /** The limit currently binding, not whether it exists. */
    is_active?: boolean;
  }[];
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function parseIso(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function severityOf(s: string | undefined): UsageWindow['severity'] {
  switch (s) {
    case 'normal':
    case 'warning':
    case 'critical':
    case 'locked':
      return s;
    default:
      return undefined;
  }
}

type ClaudeScope = NonNullable<NonNullable<ClaudeUsageResponse['limits']>[number]['scope']>;

function claudeLimitLabel(kind: string | undefined, group: string | undefined, scope: ClaudeScope | null | undefined): string {
  const scopeName = scope?.model?.display_name ?? scope?.model?.id ?? scope?.surface ?? undefined;
  if (group === 'session' || kind === 'session') return scopeName ? `Session (5h) · ${scopeName}` : 'Session (5h)';
  if (group === 'weekly' || kind?.startsWith('weekly')) {
    if (scopeName) return `Weekly · ${scopeName}`;
    if (kind && kind !== 'weekly_all' && kind !== 'weekly_scoped') return `Weekly · ${kind.slice('weekly_'.length)}`;
    return 'Weekly';
  }
  return scopeName ? `${kind ?? group ?? 'Limit'} · ${scopeName}` : kind ?? group ?? 'Limit';
}

function planLabel(subscription: string | undefined, tier: string | undefined): string | undefined {
  const parts: string[] = [];
  if (subscription) parts.push(subscription.charAt(0).toUpperCase() + subscription.slice(1));
  const m = tier ? /max_(\d+)x/.exec(tier) : null;
  if (m) parts.push(`Max ${m[1]}x`);
  else if (tier && tier !== 'default') parts.push(tier.replace(/^default_/, '').replace(/_/g, ' '));
  return parts.length ? parts.join(' · ') : undefined;
}

async function claudeAccountKey(home: string): Promise<string | undefined> {
  for (const file of [path.join(home, '.claude.json'), `${home}.json`]) {
    const config = await readJsonFile<unknown>(file);
    if (!config || typeof config !== 'object' || !('oauthAccount' in config)) continue;
    const account = config.oauthAccount;
    if (!account || typeof account !== 'object' || !('accountUuid' in account) || typeof account.accountUuid !== 'string'
      || !('organizationUuid' in account) || typeof account.organizationUuid !== 'string') continue;
    return JSON.stringify([account.accountUuid, account.organizationUuid]);
  }
  return undefined;
}

export async function fetchClaudeUsage(home: string, allowNetwork: boolean, cacheDirectory: string, interval: number): Promise<ToolUsage> {
  const base: ToolUsage = { tool: 'claude', plan: undefined, account: undefined, windows: [], asOf: Date.now(), source: 'api.anthropic.com/api/oauth/usage', error: undefined };
  const creds = await readJsonFile<ClaudeCredentials>(path.join(home, '.credentials.json'));
  const oauth = creds?.claudeAiOauth;
  base.plan = planLabel(oauth?.subscriptionType, oauth?.rateLimitTier);
  if (!allowNetwork) return { ...base, error: 'Network fetch disabled in settings' };
  if (!oauth?.accessToken) return { ...base, error: 'No Claude Code OAuth credential found (log in with `claude`)' };
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) return { ...base, error: 'Claude credential expired; run any `claude` command to refresh it' };

  let data: ClaudeUsageResponse;
  try {
    const result = await cachedClaudeUsage(cacheDirectory, oauth.accessToken, interval, () => fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    }), await claudeAccountKey(home));
    base.asOf = result.asOf;
    base.error = result.error;
    if (!result.data) return base;
    data = result.data as ClaudeUsageResponse;
  } catch (e) {
    return { ...base, error: `Usage request failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  const windows: UsageWindow[] = [];
  if (data.limits?.length) {
    for (const l of data.limits) {
      windows.push({
        label: claudeLimitLabel(l.kind, l.group, l.scope),
        percent: clamp(l.percent ?? 0),
        resetsAt: parseIso(l.resets_at),
        severity: severityOf(l.severity),
        detail: undefined,
      });
    }
  } else {
    const push = (label: string, b: ClaudeUsageBucket | null | undefined) => {
      if (!b || b.utilization == null) return;
      windows.push({ label, percent: clamp(b.utilization), resetsAt: parseIso(b.resets_at), severity: b.locked_reason ? 'locked' : undefined, detail: b.locked_reason ?? undefined });
    };
    push('Session (5h)', data.five_hour);
    push('Weekly', data.seven_day);
    push('Weekly · Opus', data.seven_day_opus);
    push('Weekly · Sonnet', data.seven_day_sonnet);
  }
  const extra = data.extra_usage;
  if (extra?.is_enabled && extra.utilization != null) {
    const money =
      extra.used_credits != null && extra.monthly_limit != null
        ? `${formatMoney(extra.used_credits, extra.currency)} of ${formatMoney(extra.monthly_limit, extra.currency)}`
        : undefined;
    windows.push({ label: 'Extra usage (month)', percent: clamp(extra.utilization), resetsAt: undefined, severity: undefined, detail: money });
  }
  return { ...base, windows };
}

function formatMoney(cents: number, currency: string | null | undefined): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency ?? 'USD' }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ---------------------------------------------------------------- Codex

interface CodexRateLimitWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface CodexRateLimits {
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string } | null;
  plan_type?: string | null;
  rate_limit_reached_type?: string | null;
}

function codexWindowLabel(minutes: number | undefined): string {
  if (!minutes) return 'Limit';
  if (minutes % 10080 === 0) return minutes === 10080 ? 'Weekly' : `${minutes / 10080} weeks`;
  if (minutes % 1440 === 0) return minutes === 1440 ? 'Daily' : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** Read the last 96 KB of a file as text. */
async function tailText(file: string, bytes = 96 * 1024): Promise<string> {
  const st = await statOrUndefined(file);
  if (!st) return '';
  const fh = await fsp.open(file, 'r');
  try {
    const start = Math.max(0, st.size - bytes);
    const buf = Buffer.alloc(st.size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

/**
 * Codex writes the account's rate-limit snapshot into every `token_count` event of a rollout,
 * so the newest such event across all rollouts is the current usage as of the last turn.
 */
async function readCodexPlan(home: string): Promise<{ plan: string | undefined; until: string | undefined; email: string | undefined }> {
  const { plan, until, email } = decodeCodexAuth(await readJsonFile(path.join(home, 'auth.json')));
  return { plan, until, email };
}

/**
 * ChatGPT plans carry no multiplier (there is no "Pro 20x" — the tiers are Free, Plus, Pro, Business, Enterprise),
 * so the label is the plan name; the token's subscription period is appended when known.
 */
function codexPlanLabel(planType: string | undefined, until: string | undefined): string | undefined {
  if (!planType) return undefined;
  const name = planType.charAt(0).toUpperCase() + planType.slice(1);
  const t = until ? Date.parse(until) : NaN;
  return Number.isFinite(t) ? `${name} · renews ${new Date(t).toLocaleDateString()}` : name;
}

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

interface CodexLiveWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

interface CodexLiveRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: CodexLiveWindow | null;
  secondary_window?: CodexLiveWindow | null;
}

/** The response of the endpoint the Codex CLI and IDE plugin poll for their own usage display (unofficial, read-only). */
interface CodexLiveUsage {
  plan_type?: string | null;
  email?: string | null;
  rate_limit?: CodexLiveRateLimit | null;
  additional_rate_limits?: { limit_name?: string; normal_model_slug?: string; rate_limit?: CodexLiveRateLimit | null }[] | null;
  credits?: { has_credits?: boolean; unlimited?: boolean; balance?: string } | null;
  rate_limit_reached_type?: string | null;
}

function liveWindows(rl: CodexLiveRateLimit | null | undefined, suffix: string, reached: boolean): UsageWindow[] {
  const both = [rl?.primary_window, rl?.secondary_window].filter((w): w is CodexLiveWindow => !!w && w.used_percent != null);
  both.sort((a, b) => (a.limit_window_seconds ?? 0) - (b.limit_window_seconds ?? 0));
  return both.map((w) => ({
    label: codexWindowLabel(w.limit_window_seconds ? w.limit_window_seconds / 60 : undefined) + suffix,
    percent: clamp(w.used_percent ?? 0),
    resetsAt: w.reset_at ? w.reset_at * 1000 : undefined,
    severity: reached ? 'locked' : undefined,
    detail: undefined,
  }));
}

/**
 * Live Codex usage from the same endpoint the Codex CLI's `/status` and the IDE plugin read, authenticated with the
 * access token in `auth.json`. Codex keeps that token fresh while it runs; a 401 here means it has not run for a
 * while, and the caller falls back to the rollout snapshot rather than refreshing the token itself.
 */
async function fetchCodexUsage(home: string): Promise<CodexLiveUsage> {
  const auth = await readJsonFile<{ tokens?: { access_token?: string; account_id?: string } }>(path.join(home, 'auth.json'));
  const token = auth?.tokens?.access_token;
  if (!token) throw new Error('not logged in to ChatGPT');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const { accountId } = decodeCodexAuth(auth);
  if (accountId) headers['chatgpt-account-id'] = accountId;
  const res = await fetch(CODEX_USAGE_URL, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(res.status === 401 ? 'login token expired (run a Codex turn to refresh it)' : `HTTP ${res.status}`);
  return (await res.json()) as CodexLiveUsage;
}

export async function readCodexUsage(home: string, allowNetwork: boolean): Promise<ToolUsage> {
  const account = await readCodexPlan(home);
  const base: ToolUsage = { tool: 'codex', plan: codexPlanLabel(account.plan, account.until), account: account.email, windows: [], asOf: 0, source: 'rate_limits recorded in the latest rollout', error: undefined };
  if (allowNetwork) {
    try {
      const live = await fetchCodexUsage(home);
      const reached = !!live.rate_limit_reached_type || !!live.rate_limit?.limit_reached;
      const windows = liveWindows(live.rate_limit, '', reached);
      for (const extra of live.additional_rate_limits ?? []) {
        const model = extra.normal_model_slug ?? extra.limit_name;
        windows.push(...liveWindows(extra.rate_limit, model ? ` · ${model}` : '', !!extra.rate_limit?.limit_reached));
      }
      if (live.credits?.has_credits) {
        windows.push({ label: 'Credits', percent: 0, resetsAt: undefined, severity: undefined, detail: live.credits.unlimited ? 'unlimited' : `balance ${live.credits.balance ?? '?'}` });
      }
      return { ...base, plan: codexPlanLabel(live.plan_type ?? account.plan, account.until), account: live.email ?? account.email, windows, asOf: Date.now(), source: 'chatgpt.com usage endpoint (the one the Codex CLI and plugin use)' };
    } catch (err) {
      base.error = `live usage unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const files = await walkFiles(path.join(home, 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
  const withTimes = await Promise.all(files.map(async (f) => ({ f, mtime: (await statOrUndefined(f))?.mtimeMs ?? 0 })));
  withTimes.sort((a, b) => b.mtime - a.mtime);

  for (const { f } of withTimes.slice(0, 40)) {
    const text = await tailText(f);
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
      let d: { timestamp?: string; payload?: { type?: string; rate_limits?: CodexRateLimits | null } };
      try {
        d = JSON.parse(line) as typeof d;
      } catch {
        continue;
      }
      const rl = d.payload?.rate_limits;
      if (d.payload?.type !== 'token_count' || !rl) continue;
      const windows: UsageWindow[] = [];
      const push = (w: CodexRateLimitWindow | null | undefined) => {
        if (!w || w.used_percent == null) return;
        windows.push({
          label: codexWindowLabel(w.window_minutes),
          percent: clamp(w.used_percent),
          resetsAt: w.resets_at ? w.resets_at * 1000 : undefined,
          severity: rl.rate_limit_reached_type ? 'locked' : undefined,
          detail: undefined,
        });
      };
      // Primary is the shorter window when both exist; list short before long.
      const both = [rl.primary, rl.secondary].filter((w): w is CodexRateLimitWindow => !!w && w.used_percent != null);
      both.sort((a, b) => (a.window_minutes ?? 0) - (b.window_minutes ?? 0));
      for (const w of both) push(w);
      const credits = rl.credits;
      if (credits?.has_credits) {
        windows.push({ label: 'Credits', percent: 0, resetsAt: undefined, severity: undefined, detail: credits.unlimited ? 'unlimited' : `balance ${credits.balance ?? '?'}` });
      }
      return {
        ...base,
        // The rollout's plan_type is the fresher of the two when the token is stale.
        plan: codexPlanLabel(rl.plan_type ?? account.plan, account.until),
        windows,
        asOf: parseIso(d.timestamp) ?? (await statOrUndefined(f))?.mtimeMs ?? Date.now(),
      };
    }
  }
  return { ...base, error: [base.error, 'No rate-limit snapshot found in recent rollouts (run a Codex turn)'].filter(Boolean).join('; ') };
}
