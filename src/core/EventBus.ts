type EventListener = (event: string, data: unknown, teamId?: string) => void;

export class TeamEventBus {
  private listeners = new Set<EventListener>();

  emit(event: string, data: unknown, teamId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(event, data, teamId);
      } catch {
        // closed connections cleaned by close handler
      }
    }
  }

  subscribe(callback: EventListener): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

let bus: TeamEventBus | null = null;

export function getEventBus(): TeamEventBus {
  if (!bus) bus = new TeamEventBus();
  return bus;
}
