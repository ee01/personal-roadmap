import { beforeAll, describe, expect, it } from 'vitest';
import { useRoadmapApi } from '../composables/useRoadmapApi';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

describe('useRoadmapApi event subscription', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
    });
  });

  it('exposes subscribeEvents separately from fetchActivity', () => {
    const api = useRoadmapApi();
    expect(typeof api.subscribeEvents).toBe('function');
    expect(typeof api.unsubscribeEvents).toBe('function');
    expect(typeof api.fetchActivity).toBe('function');
    expect(api.subscribeEvents).not.toBe(api.fetchActivity);
  });
});
