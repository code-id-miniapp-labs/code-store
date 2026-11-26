import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore,
  createPersistentStore,
  batch,
  effect,
  startBatch,
  endBatch,
  setActiveSub,
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

  it('also supports `{ unsubscribe }` destructuring', () => {
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

  it('re-exports setActiveSub from alien-signals to pause and restore tracking', () => {
    const tracked = createStore(0);
    const untracked = createStore(0);
    let runs = 0;

    const stop = effect(() => {
      runs += 1;
      void tracked.value;
      const prevSub = setActiveSub(undefined);
      try {
        void untracked.value;
      } finally {
        setActiveSub(prevSub);
      }
    });

    assert.equal(runs, 1);

    untracked.value = 1;
    assert.equal(runs, 1);

    tracked.value = 1;
    assert.equal(runs, 2);

    stop();
  });

  it('coalesces writable store subscriptions across batch() and raw startBatch()/endBatch() (including A->B->A)', () => {
    const count = createStore(0);
    const events: Array<[number, number]> = [];
    const unsub = count.subscribe((val, prev) => {
      events.push([val, prev]);
    });

    batch(() => {
      count.value = 1;
      count.value = 2;
      count.value = 5;
    });
    assert.deepEqual(events, [[5, 0]]);

    // Net no-op A->B->A inside raw startBatch/endBatch emits 0 notifications
    startBatch();
    count.value = 99;
    count.value = 5;
    endBatch();
    assert.equal(events.length, 1);

    startBatch();
    count.value = 10;
    count.value = 20;
    endBatch();
    assert.deepEqual(events, [
      [5, 0],
      [20, 5],
    ]);

    unsub();
  });

  it('keeps writable and derived subscribers consistent when both listen to the same store', () => {
    const a = createStore(1);
    const doubled = createStore(() => a.value * 2);
    const log: string[] = [];

    const unsubA = a.subscribe((val, prev) => {
      // Reading derived store inside writable listener must see the updated value
      log.push(`a:${prev}->${val}(doubled=${doubled.value})`);
    });
    const unsubD = doubled.subscribe((val, prev) => {
      log.push(`d:${prev}->${val}`);
    });

    a.value = 5;
    assert.deepEqual(log, ['a:1->5(doubled=10)', 'd:2->10']);

    log.length = 0;
    batch(() => {
      a.value = 6;
      a.value = 10;
    });
    assert.deepEqual(log, ['a:5->10(doubled=20)', 'd:10->20']);

    unsubA();
    unsubD();
  });

  it('supports subscribing the exact same listener function twice independently', () => {
    const count = createStore(0);
    const derived = createStore(() => count.value * 10);
    const seen: number[] = [];
    const derivedSeen: number[] = [];

    const fn = (val: number) => {
      seen.push(val);
    };
    const dFn = (val: number) => {
      derivedSeen.push(val);
    };

    const u1 = count.subscribe(fn);
    const u2 = count.subscribe(fn);
    const du1 = derived.subscribe(dFn);
    const du2 = derived.subscribe(dFn);

    count.value = 1;
    assert.deepEqual(seen, [1, 1]);
    assert.deepEqual(derivedSeen, [10, 10]);

    u1();
    du1();
    count.value = 2;
    assert.deepEqual(seen, [1, 1, 2]);
    assert.deepEqual(derivedSeen, [10, 10, 20]);

    u2();
    du2();
    count.value = 3;
    assert.deepEqual(seen, [1, 1, 2]);
    assert.deepEqual(derivedSeen, [10, 10, 20]);
  });

  it('shares a single derived effect across many subscribers and unwatches when all unsubscribe', () => {
    const base = createStore(1);
    let computeCount = 0;
    const derived = createStore(() => {
      computeCount += 1;
      return base.value * 2;
    });

    const unsubs: Array<() => void> = [];
    let notifyCount = 0;
    for (let i = 0; i < 50; i++) {
      unsubs.push(
        derived.subscribe(() => {
          notifyCount += 1;
        })
      );
    }

    assert.equal(computeCount, 1);

    base.value = 2;
    assert.equal(computeCount, 2);
    assert.equal(notifyCount, 50);

    // Unsubscribe all 50 -> shared effect stops and upstream links detach
    for (const u of unsubs) u();

    base.value = 3;
    base.value = 4;
    assert.equal(computeCount, 2);
    assert.equal(notifyCount, 50);
  });

  it('handles adding/removing subscribers and re-entrant writes during notification in strict causal order', () => {
    const count = createStore(0);
    const log: string[] = [];
    let unsubLate: (() => void) | undefined;

    const u1 = count.subscribe((val, prev) => {
      log.push(`L1:${prev}->${val}`);
      if (val === 1) {
        // Adding a new subscriber mid-notification must not fire for val === 1
        unsubLate = count.subscribe((v, p) => {
          log.push(`L3:${p}->${v}`);
        });
        // Re-entrant write must be queued so L2 still receives 0->1 before 1->2
        count.value = 2;
      }
    });

    let u2: (() => void) | undefined;
    u2 = count.subscribe((val, prev) => {
      log.push(`L2:${prev}->${val}`);
      if (val === 2) {
        u2?.();
      }
    });

    count.value = 1;
    assert.deepEqual(log, [
      'L1:0->1',
      'L2:0->1',
      'L1:1->2',
      'L2:1->2',
      'L3:1->2',
    ]);

    log.length = 0;
    count.value = 3;
    assert.deepEqual(log, ['L1:2->3', 'L3:2->3']);

    u1();
    unsubLate?.();
  });

  it('recovers cleanly if a listener throws during notify or immediate subscribe', () => {
    const count = createStore(0);
    const seen: number[] = [];

    assert.throws(() => {
      count.subscribe(
        () => {
          throw new Error('immediate boom');
        },
        { immediate: true }
      );
    }, /immediate boom/);

    // Failed immediate subscribe must not leak into subscriber list
    count.value = 1;

    const uBad = count.subscribe((val) => {
      if (val === 2) throw new Error('notify boom');
    });
    const uGood = count.subscribe((val) => {
      seen.push(val);
    });

    assert.throws(() => {
      count.value = 2;
    }, /notify boom/);

    uBad();
    count.value = 3;
    assert.deepEqual(seen, [3]);

    // Batched error recovery (throwing listener runs before healthy listener)
    const afterThrowSeen: number[] = [];
    const uBadBatch = count.subscribe(() => {
      throw new Error('batch boom');
    });
    const uAfterBad = count.subscribe((val) => {
      afterThrowSeen.push(val);
    });
    assert.throws(() => {
      batch(() => {
        count.value = 4;
      });
    }, /batch boom/);

    uBadBatch();
    count.value = 5;
    assert.deepEqual(seen, [3, 4, 5]);
    assert.deepEqual(afterThrowSeen, [5]);
    uGood();
    uAfterBad();
  });

  it('evaluates unwatched derived store peek() without leaking upstream links', () => {
    const source = createStore(10);
    let runs = 0;
    const ephemeral = createStore(() => {
      runs += 1;
      return source.value + 1;
    });

    assert.equal(ephemeral.peek(), 11);
    assert.equal(runs, 1);

    // Mutating source must NOT trigger recomputation of an unwatched peeked derived store
    source.value = 20;
    assert.equal(runs, 1);
    assert.equal(ephemeral.peek(), 21);
    assert.equal(runs, 2);
  });
});
