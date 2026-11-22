import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  createPersistentStore,
  batch,
} from '../dist/index.mjs';

const storage = new Map<string, unknown>();

(globalThis as unknown as { wx: unknown }).wx = {
  nextTick(cb: () => void) {
    Promise.resolve().then(cb);
  },
  onAppHide() {},
  getStorageSync(key: string) {
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorage({ key, data }: { key: string; data: unknown }) {
    storage.set(key, data);
  },
  removeStorage({ key }: { key: string }) {
    storage.delete(key);
  },
};

describe('store.subscribe()', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('returns a callable unsubscribe function and does not fire immediately by default', () => {
    const count = createStore(0);
    const events: Array<[number, number]> = [];

    const unsubscribe = count.subscribe((val, prev) => {
      events.push([val, prev]);
    });

    assert.equal(typeof unsubscribe, 'function');
    assert.equal(events.length, 0);

    count.value = 1;
    count.value = 1; // Object.is equal -> ignored
    count.value = 5;
    assert.deepEqual(events, [
      [1, 0],
      [5, 1],
    ]);

    // Unsubscribe stops further notifications and is idempotent
    unsubscribe();
    unsubscribe();

    count.value = 99;
    assert.equal(events.length, 2);
  });

  it('also supports TanStack-style `{ unsubscribe }` destructuring', () => {
    const name = createStore('Alice');
    const seen: string[] = [];

    const { unsubscribe } = name.subscribe((val) => {
      seen.push(val);
    });

    name.value = 'Bob';
    assert.deepEqual(seen, ['Bob']);

    unsubscribe();
    name.value = 'Charlie';
    assert.deepEqual(seen, ['Bob']);
  });

  it('supports `{ immediate: true }` with prevValue === undefined on initial call', () => {
    const theme = createStore<'light' | 'dark'>('light');
    const calls: Array<[string, string | undefined]> = [];

    const unsubscribe = theme.subscribe(
      (val, prev) => {
        calls.push([val, prev]);
      },
      { immediate: true }
    );

    assert.deepEqual(calls, [['light', undefined]]);

    theme.value = 'dark';
    assert.deepEqual(calls, [
      ['light', undefined],
      ['dark', 'light'],
    ]);

    unsubscribe();
  });

  it('works on derived stores and coalesces batch() updates (suppressing A->B->A)', () => {
    const a = createStore(1);
    const b = createStore(2);
    const sum = createStore(() => a.value + b.value);

    const events: Array<[number, number]> = [];
    const unsubscribe = sum.subscribe((val, prev) => {
      events.push([val, prev]);
    });

    batch(() => {
      a.value = 10;
      b.value = 20;
    });
    assert.deepEqual(events, [[30, 3]]);

    // Net no-op inside batch -> 0 notifications
    batch(() => {
      a.value = 15;
      b.value = 15;
    });
    assert.equal(events.length, 1);

    unsubscribe();
  });

  it('works on persistent stores (hydrates lazily, notifies on set/reset/clear)', () => {
    storage.set('sub:theme', 'dark');
    const theme = createPersistentStore<'light' | 'dark'>('sub:theme', 'light');
    const events: Array<[string, string]> = [];

    const unsubscribe = theme.subscribe((val, prev) => {
      events.push([val, prev]);
    });

    assert.equal(theme.peek(), 'dark');
    assert.equal(events.length, 0);

    theme.value = 'light';
    theme.value = 'dark';
    theme.reset();
    assert.deepEqual(events, [
      ['light', 'dark'],
      ['dark', 'light'],
      ['light', 'dark'],
    ]);

    theme.value = 'dark';
    theme.clear();
    assert.deepEqual(events.slice(3), [
      ['dark', 'light'],
      ['light', 'dark'],
    ]);

    unsubscribe();
    theme.value = 'dark';
    assert.equal(events.length, 5);
  });

  it('does not accidentally subscribe to other stores read inside the listener', () => {
    const count = createStore(0);
    const other = createStore('a');
    let runs = 0;

    const unsubscribe = count.subscribe(() => {
      runs += 1;
      void other.value; // Reading another store must NOT attach a dependency
    });

    count.value = 1;
    assert.equal(runs, 1);

    other.value = 'b';
    assert.equal(runs, 1);

    unsubscribe();
  });

  it('safely supports self-unsubscribing inside a listener', () => {
    const count = createStore(0);
    const seen: number[] = [];

    const unsubscribe = count.subscribe((val) => {
      seen.push(val);
      if (val >= 2) {
        unsubscribe();
      }
    });

    count.value = 1;
    count.value = 2;
    count.value = 3;
    count.value = 4;

    assert.deepEqual(seen, [1, 2]);
  });
});
