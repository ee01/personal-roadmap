import { beforeEach, describe, expect, it } from 'vitest';
import {
  EDIT_TOKEN_PREFIX,
  KNOWN_TEAMS_KEY,
  listKnownTeamIds,
  rememberKnownTeam,
} from '../composables/useRoadmapApi';

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

describe('known teams localStorage', () => {
  let store: MemoryStorage;

  beforeEach(() => {
    store = new MemoryStorage();
  });

  it('seeds from existing edit tokens and remembers new ids', () => {
    store.setItem(`${EDIT_TOKEN_PREFIX}alpha`, 'rw_token');
    expect(listKnownTeamIds(store)).toEqual(['alpha']);
    expect(JSON.parse(store.getItem(KNOWN_TEAMS_KEY) || '[]')).toEqual(['alpha']);

    rememberKnownTeam('beta', store);
    rememberKnownTeam('alpha', store);
    expect(listKnownTeamIds(store)).toEqual(['alpha', 'beta']);
  });

  it('ignores blank ids', () => {
    rememberKnownTeam('  ', store);
    expect(listKnownTeamIds(store)).toEqual([]);
  });
});
