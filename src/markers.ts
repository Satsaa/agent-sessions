import type { Session, Tool } from './types.js';

/** How much of a first prompt is kept for the marker to be found in: a marker goes at the start. */
export const PROMPT_HEAD = 1000;

/**
 * The `agentSessions.parentSessionMarker` pattern, compiled; undefined when empty or not a valid regular expression.
 * Its `id` group names the parent session, its optional `tool` group the parent's tool (the child's own without it).
 */
export function parentMarker(source: string): RegExp | undefined {
  if (!source.trim()) return undefined;
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

const isTool = (value: string | undefined): value is Tool => value === 'claude' || value === 'codex';

/**
 * Sessions another agent started with a marker in their first prompt become that agent's subagents. A session its
 * own tool already knows as spawned keeps what the tool recorded.
 */
export function withMarkedParents(sessions: Session[], marker: RegExp | undefined): Session[] {
  if (!marker) return sessions;
  return sessions.map((s) => {
    if (s.subagent || !s.promptHead) return s;
    const groups = marker.exec(s.promptHead)?.groups;
    const parentId = groups?.id?.trim();
    if (!parentId) return s;
    const parentTool = isTool(groups?.tool) ? groups.tool : s.tool;
    if (parentTool === s.tool && parentId === s.id) return s;
    return { ...s, subagent: true, parentId, parentTool, agentRole: groups?.role?.trim() || s.agentRole };
  });
}
