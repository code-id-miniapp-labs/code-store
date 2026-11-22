import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  effect,
  batch,
  bindStore,
  createPersistentStore,
} from '../dist/index.mjs';

interface StorageCall {
  op: 'getSync' | 'set' | 'batchSet' | 'setSync' | 'batchSetSync' | 'remove' | 'removeSync';
  key?: string;
  data?: unknown;
  kvList?: Array<{ key: string; value: unknown }>;
}

const storage = new Map<string, unknown>();
const calls: StorageCall[] = [];
const appHideListeners: Array<() => void> = [];
let nextTickQueue: Array<() => void> = [];

function triggerAppHide() {
  for (const fn of appHideListeners) fn();
}

function flushNextTicks() {
  const queue = nextTickQueue;
  nextTickQueue = [];
  for (const fn of queue) fn();
}

const mockWx: Record<string, any> = {
  nextTick(cb: () => void) {
    nextTickQueue.push(cb);
  },
  onAppHide(cb: () => void) {
    appHideListeners.push(cb);
  },
  getStorageSync(key: string) {
    calls.push({ op: 'getSync', key });
    return storage.has(key) ? storage.get(key) : '';
  },
  setStorage({ key, data }: { key: string; data: unknown }) {
    calls.push({ op: 'set', key, data });
    storage.set(key, data);
  },
  batchSetStorage({ kvList }: { kvList: Array<{ key: string; value: unknown }> }) {
    calls.push({ op: 'batchSet', kvList: [...kvList] });
    for (const item of kvList) storage.set(item.key, item.value);
  },
  setStorageSync(key: string, data: unknown) {
    calls.push({ op: 'setSync', key, data });
    storage.set(key, data);
  },
  batchSetStorageSync(kvList: Array<{ key: string; value: unknown }>) {
    calls.push({ op: 'batchSetSync', kvList: [...kvList] });
    for (const item of kvList) storage.set(item.key, item.value);
  },
  removeStorage({ key }: { key: string }) {
    calls.push({ op: 'remove', key });
    storage.delete(key);
  },
  removeStorageSync(key: string) {
    calls.push({ op: 'removeSync', key });
    storage.delete(key);
  },
};

(globalThis as unknown as { wx: unknown }).wx = mockWx;

describe('createPersistentStore (lazy hydration, wx.nextTick, wx.batchSetStorage, auto wx.onAppHide)', () => {
  beforeEach(() => {
    triggerAppHide();
    flushNextTicks();
    storage.clear();
    calls.length = 0;
  });

  it('defers wx.getStorageSync until first read (zero cold-start stampede)', () => {
    storage.set('lazy:count', 42);
    storage.set('lazy:flag', false);

    const lazyCount = createPersistentStore('lazy:count', 0);
    const lazyFlag = createPersistentStore('lazy:flag', true);
    const unused = createPersistentStore('lazy:unused', 'default');

    assert.equal(calls.length, 0);

    assert.equal(lazyCount.value, 42);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.op, 'getSync');

    assert.equal(lazyCount.value, 42);
    assert.equal(lazyCount.peek(), 42);
    assert.equal(calls.length, 1);

    assert.equal(lazyFlag.peek(), false);
    assert.equal(calls.length, 2);
    void unused;
  });

  it('skips disk read when written before first read', () => {
    storage.set('writeFirst:key', 'old');
    const store = createPersistentStore('writeFirst:key', 'default');

    store.value = 'new';
    assert.equal(store.value, 'new');
    assert.equal(calls.filter((c) => c.op === 'getSync').length, 0);

    flushNextTicks();
    assert.deepEqual(calls, [{ op: 'set', key: 'writeFirst:key', data: 'new' }]);
  });

  it('flushes UI setData (microtask) BEFORE storage persistence (wx.nextTick) and coalesces across microtasks', async () => {
    const theme = createPersistentStore('order:theme', 'light');
    const locale = createPersistentStore('order:locale', 'zh_CN');
    const timeline: string[] = [];

    const handle = bindStore(
      {
        data: { theme: 'light', locale: 'zh_CN' },
        setData(patch) {
          timeline.push(`setData:${Object.keys(patch).join(',')}`);
        },
      },
      { theme, locale }
    );
    calls.length = 0;

    theme.value = 'dark';
    await Promise.resolve();

    // Microtask already flushed UI setData; wx.nextTick has NOT persisted to storage yet
    assert.deepEqual(timeline, ['setData:theme']);
    assert.equal(calls.length, 0);

    // Another write in a subsequent microtask within the same render slice still coalesces!
    locale.value = 'en_US';
    await Promise.resolve();
    assert.deepEqual(timeline, ['setData:theme', 'setData:locale']);
    assert.equal(calls.length, 0);

    // Now the render slice commits -> wx.nextTick batches BOTH stores in ONE IPC call
    flushNextTicks();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.op, 'batchSet');
    assert.deepEqual(calls[0]?.kvList, [
      { key: 'order:theme', value: 'dark' },
      { key: 'order:locale', value: 'en_US' },
    ]);

    handle.dispose();
  });

  it('batches multiple dirty stores into ONE wx.batchSetStorage IPC call', () => {
    const theme = createPersistentStore('batch:theme', 'light');
    const locale = createPersistentStore('batch:locale', 'zh_CN');
    const discount = createPersistentStore('batch:discount', 1.0);

    batch(() => {
      theme.value = 'dark';
      locale.value = 'en_US';
      discount.value = 0.85;
    });

    assert.equal(calls.length, 0);
    flushNextTicks();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.op, 'batchSet');
    assert.deepEqual(calls[0]?.kvList, [
      { key: 'batch:theme', value: 'dark' },
      { key: 'batch:locale', value: 'en_US' },
      { key: 'batch:discount', value: 0.85 },
    ]);
  });

  it('auto-flushes pending nextTick & debounced writes synchronously on wx.onAppHide without double-writing', async () => {
    const instant = createPersistentStore('hide:instant', 'a');
    const draft = createPersistentStore('hide:draft', '', { debounceMs: 60 });

    instant.value = 'b';
    draft.value = 'hello';

    assert.equal(calls.length, 0);
    assert.equal(appHideListeners.length, 1);

    // App backgrounds BEFORE wx.nextTick or debounce timer fires
    triggerAppHide();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.op, 'batchSetSync');
    assert.deepEqual(calls[0]?.kvList, [
      { key: 'hide:instant', value: 'b' },
      { key: 'hide:draft', value: 'hello' },
    ]);

    // Stale wx.nextTick and expired debounce timer must NOT double-write
    flushNextTicks();
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(calls.length, 1);
  });

  it('falls back to microtask when wx.nextTick is unavailable', async () => {
    const origNextTick = mockWx.nextTick;
    mockWx.nextTick = undefined;
    try {
      const store = createPersistentStore('fallback:key', 0);
      store.value = 7;
      assert.equal(calls.length, 0);

      await Promise.resolve();
      assert.deepEqual(calls, [{ op: 'set', key: 'fallback:key', data: 7 }]);
    } finally {
      mockWx.nextTick = origNextTick;
    }
  });

  it('supports .reset(), .clear(), and does not subscribe effects on write/peek', () => {
    const target = createPersistentStore('ops:count', 10);
    let runs = 0;

    const stop = effect(() => {
      runs += 1;
      const cur = target.peek();
      target.value = cur + 1;
    });

    assert.equal(runs, 1);
    assert.equal(target.value, 11);

    target.reset();
    assert.equal(target.value, 10);
    assert.equal(runs, 1);
    flushNextTicks();
    assert.equal(storage.get('ops:count'), 10);

    target.clear();
    assert.equal(target.value, 10);
    flushNextTicks();
    assert.equal(storage.has('ops:count'), false);

    stop();
  });
});
