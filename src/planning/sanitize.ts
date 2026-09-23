import type { ActorContext } from '../types.js';

const SECRET_KEYS = new Set([
  'sharetoken',
  'share_token',
  'token',
  'edittoken',
  'apiKey',
  'apikey',
  'authorization',
  'password',
  'secret',
  'pat',
  'jira_pat',
]);

export function publicActor(actor: ActorContext): {
  name: string;
  clientId: string;
  source: ActorContext['source'];
} {
  return {
    name: actor.name,
    clientId: actor.clientId,
    source: actor.source,
  };
}

export function stripSecrets<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key.toLowerCase())) continue;
      out[key] = strip(nested);
    }
    return out;
  }
  return value;
}

export function publicIntentEvent(
  op: string,
  intent: Record<string, unknown>,
  actor: ActorContext,
): { op: string; intent: Record<string, unknown>; actor: ReturnType<typeof publicActor> } {
  return {
    op,
    intent: stripSecrets(intent),
    actor: publicActor(actor),
  };
}

const EVENT_ALLOW = new Set([
  'connected',
  'snapshot',
  'intent',
  'activity',
  'presence',
  'team_created',
  'planning',
  'lock',
  'unlock',
]);

export function serializeTeamEvent(
  event: string,
  data: unknown,
): { event: string; data: unknown } | null {
  if (!EVENT_ALLOW.has(event)) return null;
  return { event, data: stripSecrets(data) };
}
