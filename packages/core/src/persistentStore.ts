import { signal as rawSignal } from 'alien-signals';
import { subscribeStore } from './store';
import {
  STORE_SYMBOL,
  type ImmediateStoreListener,
  type PersistentStore,
  type PersistentStoreOptions,
  type StoreListener,
  type SubscribeOptions,
  type Subscription,
} from './types';

const REMOVE_SENTINEL = Symbol('code-store:remove');

interface PendingWrite {
  value: unknown;
  onError?: ((error: unknown) => void) | undefined;
}

const pendingQueue = new Map<string, PendingWrite>();
const debouncedQueue = new Map<string, PendingWrite>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

let flushScheduled = false;
let appHideListenerRegistered = false;

function hasWx(): boolean {
  return typeof wx !== 'undefined' && wx !== null;
}

function scheduleFlush(fn: () => void): void {
  if (hasWx() && typeof wx.nextTick === 'function') {
    wx.nextTick(fn);
  } else {
    Promise.resolve().then(fn);
  }
}

function writeSingleAsync(key: string, entry: PendingWrite): void {
  if (!hasWx()) return;

  if (entry.value === REMOVE_SENTINEL || entry.value === undefined) {
    if (entry.onError) {
      wx.removeStorage({ key, fail: entry.onError });
    } else {
      wx.removeStorage({ key });
    }
    return;
  }

  if (entry.onError) {
    wx.setStorage({ key, data: entry.value, fail: entry.onError });
  } else {
    wx.setStorage({ key, data: entry.value });
  }
}

function flushEntriesAsync(entries: Map<string, PendingWrite>): void {
  if (entries.size === 0 || !hasWx()) {
    entries.clear();
    return;
  }

  if (entries.size === 1) {
    for (const [key, entry] of entries) {
      writeSingleAsync(key, entry);
    }
    entries.clear();
    return;
  }

  const canBatchSet = typeof wx.batchSetStorage === 'function';
  const kvList: Array<{ key: string; value: unknown }> = [];
  const batchErrorHandlers: Array<(err: unknown) => void> = [];

  for (const [key, entry] of entries) {
    if (entry.value === REMOVE_SENTINEL || entry.value === undefined) {
      writeSingleAsync(key, entry);
    } else if (canBatchSet) {
      kvList.push({ key, value: entry.value });
      if (entry.onError) batchErrorHandlers.push(entry.onError);
    } else {
      writeSingleAsync(key, entry);
    }
  }

  entries.clear();

  if (kvList.length === 1) {
    const first = kvList[0];
    if (first) {
      const failHandler = batchErrorHandlers[0];
      if (failHandler) {
        wx.setStorage({ key: first.key, data: first.value, fail: failHandler });
      } else {
        wx.setStorage({ key: first.key, data: first.value });
      }
    }
  } else if (kvList.length > 1) {
    if (batchErrorHandlers.length > 0) {
      wx.batchSetStorage({
        kvList,
        fail: (err: unknown) => {
          for (let i = 0; i < batchErrorHandlers.length; i++) {
            batchErrorHandlers[i]?.(err);
          }
        },
      });
    } else {
      wx.batchSetStorage({ kvList });
    }
  }
}

function flushPendingQueue(): void {
  flushScheduled = false;
  flushEntriesAsync(pendingQueue);
}

function flushAllPendingSync(): void {
  if (
    pendingQueue.size === 0 &&
    debouncedQueue.size === 0 &&
    debounceTimers.size === 0
  ) {
    return;
  }

  debounceTimers.forEach((timer) => clearTimeout(timer));
  debounceTimers.clear();

  if (!hasWx()) {
    pendingQueue.clear();
    debouncedQueue.clear();
    return;
  }

  const canBatchSync = typeof wx.batchSetStorageSync === 'function';
  const kvList: Array<{ key: string; value: unknown }> = [];
  const batchErrorHandlers: Array<(err: unknown) => void> = [];

  const collect = (entry: PendingWrite, key: string): void => {
    if (entry.value === REMOVE_SENTINEL || entry.value === undefined) {
      try {
        wx.removeStorageSync(key);
      } catch (err) {
        entry.onError?.(err);
      }
      return;
    }

    if (canBatchSync) {
      kvList.push({ key, value: entry.value });
      if (entry.onError) batchErrorHandlers.push(entry.onError);
    } else {
      try {
        wx.setStorageSync(key, entry.value);
      } catch (err) {
        entry.onError?.(err);
      }
    }
  };

  pendingQueue.forEach(collect);
  pendingQueue.clear();
  debouncedQueue.forEach(collect);
  debouncedQueue.clear();

  if (kvList.length === 1) {
    const first = kvList[0];
    if (first) {
      try {
        wx.setStorageSync(first.key, first.value);
      } catch (err) {
        batchErrorHandlers[0]?.(err);
      }
    }
  } else if (kvList.length > 1) {
    try {
      wx.batchSetStorageSync(kvList);
    } catch (err) {
      for (let i = 0; i < batchErrorHandlers.length; i++) {
        batchErrorHandlers[i]?.(err);
      }
    }
  }
}

function ensureAppHideListener(): void {
  if (appHideListenerRegistered || !hasWx()) {
    return;
  }
  if (typeof wx.onAppHide === 'function') {
    appHideListenerRegistered = true;
    wx.onAppHide(flushAllPendingSync);
  }
}

function schedulePersist(
  key: string,
  value: unknown,
  debounceMs: number,
  onError?: (error: unknown) => void
): void {
  ensureAppHideListener();

  const entry: PendingWrite = onError ? { value, onError } : { value };

  if (debounceMs > 0) {
    pendingQueue.delete(key);
    debouncedQueue.set(key, entry);

    const existing = debounceTimers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      const latest = debouncedQueue.get(key);
      debouncedQueue.delete(key);
      if (latest) {
        writeSingleAsync(key, latest);
      }
    }, debounceMs);

    debounceTimers.set(key, timer);
    return;
  }

  const existingTimer = debounceTimers.get(key);
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer);
    debounceTimers.delete(key);
    debouncedQueue.delete(key);
  }

  pendingQueue.set(key, entry);
  if (!flushScheduled) {
    flushScheduled = true;
    scheduleFlush(flushPendingQueue);
  }
}

class PersistentStoreImpl<T> implements PersistentStore<T> {
  readonly [STORE_SYMBOL] = true as const;
  private readonly _key: string;
  private readonly _defaultValue: T;
  private readonly _debounceMs: number;
  private readonly _onError: ((error: unknown) => void) | undefined;
  private _raw: { (): T; (value: T): void } | undefined;
  private _current: T;
  private _hydrated = false;

  constructor(
    key: string,
    defaultValue: T,
    debounceMs: number,
    onError?: (error: unknown) => void
  ) {
    this._key = key;
    this._defaultValue = defaultValue;
    this._debounceMs = debounceMs;
    this._onError = onError;
    this._current = defaultValue;
  }

  // Hydrate lazily on first read to keep cold-start storage I/O at zero.
  private _hydrate(): void {
    if (this._hydrated) return;
    this._hydrated = true;

    if (!hasWx()) return;
    try {
      const cached: unknown = wx.getStorageSync(this._key);
      if (cached !== '' && cached !== undefined) {
        this._current = cached as T;
      }
    } catch (err) {
      this._onError?.(err);
    }
  }

  private _ensureSignal(): { (): T; (value: T): void } {
    if (!this._raw) {
      this._raw = rawSignal<T>(this._current);
    }
    return this._raw;
  }

  get value(): T {
    this._hydrate();
    return this._ensureSignal()();
  }

  set value(next: T) {
    if (!this._hydrated) {
      this._hydrated = true;
      this._current = next;
      if (this._raw) {
        this._raw(next);
      }
      schedulePersist(this._key, next, this._debounceMs, this._onError);
      return;
    }

    if (Object.is(this._current, next)) {
      return;
    }

    this._current = next;
    if (this._raw) {
      this._raw(next);
    }
    schedulePersist(this._key, next, this._debounceMs, this._onError);
  }

  peek(): T {
    this._hydrate();
    return this._current;
  }

  reset(): void {
    this.value = this._defaultValue;
  }

  clear(): void {
    this._hydrated = true;
    if (!Object.is(this._current, this._defaultValue)) {
      this._current = this._defaultValue;
      if (this._raw) {
        this._raw(this._defaultValue);
      }
    }
    schedulePersist(this._key, REMOVE_SENTINEL, 0, this._onError);
  }

  subscribe(listener: StoreListener<T>): Subscription;
  subscribe(
    listener: ImmediateStoreListener<T>,
    options: { immediate: true }
  ): Subscription;
  subscribe(
    listener: StoreListener<T>,
    options?: { immediate?: false }
  ): Subscription;
  subscribe(
    listener: StoreListener<T> | ImmediateStoreListener<T>,
    options?: SubscribeOptions
  ): Subscription {
    return subscribeStore(() => this.value, listener, options);
  }
}

/** Creates a lazy-hydrated persistent store backed by WeChat local storage. */
export function createPersistentStore<T>(
  key: string,
  defaultValue: T,
  options?: PersistentStoreOptions
): PersistentStore<T> {
  return new PersistentStoreImpl<T>(
    key,
    defaultValue,
    options?.debounceMs ?? 0,
    options?.onError
  );
}
