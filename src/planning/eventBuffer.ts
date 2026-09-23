import { getEventBus } from '../core/EventBus.js';

type Queued = { event: string; data: unknown; teamId?: string };

let depth = 0;
const queue: Queued[] = [];

export function runWithBufferedEvents<T>(fn: () => T): T {
  depth += 1;
  const mark = queue.length;
  try {
    const result = fn();
    if (depth === 1) {
      const pending = queue.splice(0);
      for (const item of pending) {
        getEventBus().emit(item.event, item.data, item.teamId);
      }
    }
    return result;
  } catch (error) {
    queue.length = mark;
    throw error;
  } finally {
    depth -= 1;
  }
}

export function emitTeamEvent(
  event: string,
  data: unknown,
  teamId?: string,
): void {
  if (depth > 0) {
    queue.push({ event, data, teamId });
    return;
  }
  getEventBus().emit(event, data, teamId);
}
