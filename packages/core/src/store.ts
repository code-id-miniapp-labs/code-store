import {
  signal as rawSignal,
  computed as rawComputed,
  effect,
  startBatch,
  endBatch,
  getActiveSub,
  getBatchDepth,
  setActiveSub,
} from 'alien-signals';
import {
  STORE_SYMBOL,
  type ImmediateStoreListener,
  type ReadonlyStore,
  type Store,
  type StoreListener,
  type SubscribeOptions,
  type Subscription,
} from './types';

export type AnyListener<T> = (value: T, prevValue: T) => void;

export interface ListenerHost<T> {
  _sub: AnyListener<T> | Set<AnyListener<T>> | undefined;
  _flags: number;
}

export interface WritableCore<T> extends ListenerHost<T> {
  _current: T;
  _raw: { (): T; (value: T): void } | undefined;
}

export interface InternalSubscribable<T> {
  _attach(listener: AnyListener<T>): AnyListener<T>;
  _detach(fn: AnyListener<T>): void;
}

const FLAG_BATCH_DIRTY = 1;
const FLAG_NOTIFY_STEP = 2;

const dirtyWritables: Array<WritableCore<unknown>> = [];
const dirtyPrevVals: unknown[] = [];
let inSubDispatch = false;

let batchTick: { (): number; (value: number): void } | undefined;
let batchTickVersion = 0;
let batchEffectScheduled = false;

export function addListener<T>(
  host: ListenerHost<T>,
  listener: AnyListener<T>
): AnyListener<T> {
  const current = host._sub;
  if (current === undefined) {
    host._sub = listener;
    return listener;
  }

  let fn = listener;
  if (typeof current === 'function') {
    if (current === fn) {
      fn = (v: T, p: T) => listener(v, p);
    }
    const set = new Set<AnyListener<T>>();
    set.add(current);
    set.add(fn);
    host._sub = set;
    return fn;
  }

  if (current.has(fn)) {
    fn = (v: T, p: T) => listener(v, p);
  }
  if (host._flags >= FLAG_NOTIFY_STEP) {
    // Copy-on-write during notification so new listeners do not fire for the in-progress change.
    const nextSet = new Set(current);
    nextSet.add(fn);
    host._sub = nextSet;
  } else {
    current.add(fn);
  }
  return fn;
}

export function removeListener<T>(
  host: ListenerHost<T>,
  fn: AnyListener<T>
): boolean {
  const current = host._sub;
  if (current === undefined) {
    return true;
  }
  if (current === fn) {
    host._sub = undefined;
    return true;
  }
  if (typeof current !== 'function') {
    current.delete(fn);
    if (current.size === 0) {
      host._sub = undefined;
      return true;
    }
  }
  return false;
}

function dispatchListeners<T>(
  host: ListenerHost<T>,
  nextVal: T,
  prevVal: T
): void {
  const sub = host._sub;
  if (sub === undefined) {
    return;
  }

  host._flags += FLAG_NOTIFY_STEP;
  const prevActiveSub = setActiveSub(undefined);
  try {
    if (typeof sub === 'function') {
      sub(nextVal, prevVal);
    } else {
      for (const fn of sub) {
        if (host._sub !== sub) {
          const latest = host._sub;
          if (
            latest === undefined ||
            (typeof latest === 'function' ? latest !== fn : !latest.has(fn))
          ) {
            continue;
          }
        }
        fn(nextVal, prevVal);
      }
    }
  } finally {
    setActiveSub(prevActiveSub);
    host._flags -= FLAG_NOTIFY_STEP;
  }
}

export function subscribeInternal<T>(
  store: ReadonlyStore<T> & InternalSubscribable<T>,
  listener: StoreListener<T> | ImmediateStoreListener<T>,
  options?: SubscribeOptions
): Subscription {
  let target: InternalSubscribable<T> | undefined = store;
  let fn: AnyListener<T> | undefined = store._attach(
    listener as AnyListener<T>
  );

  const unsubscribe = (() => {
    if (target !== undefined && fn !== undefined) {
      const s = target;
      const l = fn;
      // Release references immediately so retained unsubscribe handles never pin stores or listeners.
      target = undefined;
      fn = undefined;
      s._detach(l);
    }
  }) as Subscription;
  unsubscribe.unsubscribe = unsubscribe;

  if (options?.immediate === true) {
    const currentVal = store.peek();
    const prevSub = setActiveSub(undefined);
    try {
      (listener as ImmediateStoreListener<T>)(currentVal, undefined);
    } catch (err) {
      unsubscribe();
      throw err;
    } finally {
      setActiveSub(prevSub);
    }
  }

  return unsubscribe;
}

function enqueueDirtyWritable<T>(store: WritableCore<T>, prevVal: T): void {
  if ((store._flags & FLAG_BATCH_DIRTY) === 0) {
    store._flags |= FLAG_BATCH_DIRTY;
    dirtyWritables.push(store as WritableCore<unknown>);
    dirtyPrevVals.push(prevVal);
  }
}

function scheduleBatchWritableFlush(): void {
  if (batchEffectScheduled) {
    return;
  }
  if (batchTick === undefined) {
    batchTick = rawSignal(0);
    const prevSub = setActiveSub(undefined);
    try {
      effect(() => {
        batchTick!();
        if (batchEffectScheduled) {
          batchEffectScheduled = false;
          flushDirtyWritables();
        }
      });
    } finally {
      setActiveSub(prevSub);
    }
  }
  batchEffectScheduled = true;
  batchTick(++batchTickVersion);
}

function flushDirtyWritables(): void {
  if (dirtyWritables.length === 0) {
    return;
  }

  const wasInDispatch = inSubDispatch;
  inSubDispatch = true;
  let i = 0;
  try {
    while (i < dirtyWritables.length) {
      const store = dirtyWritables[i]!;
      const prevVal = dirtyPrevVals[i];
      dirtyWritables[i] = undefined as unknown as WritableCore<unknown>;
      dirtyPrevVals[i] = undefined;
      i++;

      store._flags &= ~FLAG_BATCH_DIRTY;
      const nextVal = store._current;
      if (store._sub !== undefined && !Object.is(prevVal, nextVal)) {
        dispatchListeners(store, nextVal, prevVal);
      }
    }
  } finally {
    for (; i < dirtyWritables.length; i++) {
      const store = dirtyWritables[i];
      if (store !== undefined) {
        store._flags &= ~FLAG_BATCH_DIRTY;
      }
    }
    dirtyWritables.length = 0;
    dirtyPrevVals.length = 0;
    inSubDispatch = wasInDispatch;
  }
}

export function notifyWritableChange<T>(
  store: WritableCore<T>,
  nextVal: T,
  prevVal: T
): void {
  const hasRaw = store._raw !== undefined;
  if (store._sub === undefined) {
    if (hasRaw) {
      store._raw!(nextVal);
    }
    return;
  }

  if (getBatchDepth() > 0) {
    enqueueDirtyWritable(store, prevVal);
    scheduleBatchWritableFlush();
    if (hasRaw) {
      store._raw!(nextVal);
    }
    return;
  }

  if (inSubDispatch) {
    enqueueDirtyWritable(store, prevVal);
    if (hasRaw) {
      store._raw!(nextVal);
    }
    return;
  }

  if (hasRaw) {
    // Batch the raw signal update so direct subscribers see up-to-date derived values
    // before derived/effect subscribers flush.
    startBatch();
    try {
      store._raw!(nextVal);
      inSubDispatch = true;
      try {
        dispatchListeners(store, nextVal, prevVal);
        if (dirtyWritables.length > 0) {
          flushDirtyWritables();
        }
      } finally {
        inSubDispatch = false;
      }
    } finally {
      endBatch();
    }
    return;
  }

  inSubDispatch = true;
  try {
    dispatchListeners(store, nextVal, prevVal);
    if (dirtyWritables.length > 0) {
      flushDirtyWritables();
    }
  } finally {
    inSubDispatch = false;
  }
}

/** Shared base putting `[STORE_SYMBOL]` on the prototype (zero own slots per store instance). */
export abstract class StoreBase<T>
  implements ReadonlyStore<T>, ListenerHost<T>, InternalSubscribable<T>
{
  _sub: AnyListener<T> | Set<AnyListener<T>> | undefined = undefined;
  _flags = 0;

  get [STORE_SYMBOL](): true {
    return true;
  }

  abstract readonly value: T;
  abstract peek(): T;
  abstract _attach(listener: AnyListener<T>): AnyListener<T>;
  abstract _detach(fn: AnyListener<T>): void;

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
    return subscribeInternal(this, listener, options);
  }
}

class StoreImpl<T> extends StoreBase<T> implements Store<T>, WritableCore<T> {
  private readonly _initial: T;
  _current: T;
  _raw: { (): T; (value: T): void } | undefined = undefined;

  constructor(initialValue: T) {
    super();
    this._initial = initialValue;
    this._current = initialValue;
  }

  get value(): T {
    if (getActiveSub() !== undefined) {
      let raw = this._raw;
      if (raw === undefined) {
        raw = rawSignal<T>(this._current);
        this._raw = raw;
      }
      return raw();
    }
    return this._current;
  }

  set value(next: T) {
    const prev = this._current;
    if (Object.is(prev, next)) {
      return;
    }
    this._current = next;
    notifyWritableChange(this, next, prev);
  }

  peek(): T {
    return this._current;
  }

  reset(): void {
    this.value = this._initial;
  }

  _attach(listener: AnyListener<T>): AnyListener<T> {
    return addListener(this, listener);
  }

  _detach(fn: AnyListener<T>): void {
    removeListener(this, fn);
  }
}

class DerivedStoreImpl<T> extends StoreBase<T> {
  private readonly _getter: (prev?: T) => T;
  private _raw: (() => T) | undefined = undefined;
  private _stopEffect: (() => void) | undefined = undefined;
  private _prevVal: T | undefined = undefined;
  private _hasPrev = false;

  constructor(getter: (prev?: T) => T) {
    super();
    this._getter = getter;
  }

  private _ensureComputed(): () => T {
    let raw = this._raw;
    if (raw === undefined) {
      raw = rawComputed<T>(this._getter);
      this._raw = raw;
    }
    return raw;
  }

  get value(): T {
    return this._ensureComputed()();
  }

  peek(): T {
    const prevSub = setActiveSub(undefined);
    try {
      const raw = this._raw;
      return raw !== undefined ? raw() : this._getter();
    } finally {
      setActiveSub(prevSub);
    }
  }

  _attach(listener: AnyListener<T>): AnyListener<T> {
    if (this._stopEffect === undefined) {
      const raw = this._ensureComputed();
      const prevSub = setActiveSub(undefined);
      try {
        this._stopEffect = effect(() => {
          const nextVal = raw();
          if (!this._hasPrev) {
            this._hasPrev = true;
            this._prevVal = nextVal;
            return;
          }
          if (Object.is(this._prevVal, nextVal)) {
            return;
          }
          const oldVal = this._prevVal as T;
          this._prevVal = nextVal;
          dispatchListeners(this, nextVal, oldVal);
        });
      } finally {
        setActiveSub(prevSub);
      }
    }
    return addListener(this, listener);
  }

  _detach(fn: AnyListener<T>): void {
    if (removeListener(this, fn) && this._stopEffect !== undefined) {
      const stop = this._stopEffect;
      this._stopEffect = undefined;
      this._hasPrev = false;
      this._prevVal = undefined;
      stop();
    }
  }
}

/** Returns `true` if `value` is a reactive store created by `createStore` or `createPersistentStore`. */
export function isStore(value: unknown): value is ReadonlyStore<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[STORE_SYMBOL] === true
  );
}

/** Creates a derived read-only store when given a getter function. */
export function createStore<T>(getter: (prev?: T) => T): ReadonlyStore<T>;
/** Creates a writable atomic store when given an initial value. */
export function createStore<T>(initialValue: T): Store<T>;
export function createStore<T>(
  initialOrGetter: T | ((prev?: T) => T)
): Store<T> | ReadonlyStore<T> {
  if (typeof initialOrGetter === 'function') {
    return new DerivedStoreImpl<T>(initialOrGetter as (prev?: T) => T);
  }
  return new StoreImpl<T>(initialOrGetter);
}

/** Runs multiple store updates in a single batch. */
export function batch<T>(fn: () => T): T {
  startBatch();
  try {
    return fn();
  } finally {
    endBatch();
  }
}
