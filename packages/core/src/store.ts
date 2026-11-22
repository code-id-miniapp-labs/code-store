import {
  signal as rawSignal,
  computed as rawComputed,
  effect,
  startBatch,
  endBatch,
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

export function subscribeStore<T>(
  read: () => T,
  listener: StoreListener<T> | ImmediateStoreListener<T>,
  options?: SubscribeOptions
): Subscription {
  const immediate = options?.immediate === true;
  let initialized = false;
  let active = true;
  let prevVal: T;

  const stop = effect(() => {
    const nextVal = read();

    if (!initialized) {
      initialized = true;
      prevVal = nextVal;
      if (immediate) {
        const prevSub = setActiveSub(undefined);
        try {
          (listener as ImmediateStoreListener<T>)(nextVal, undefined);
        } finally {
          setActiveSub(prevSub);
        }
      }
      return;
    }

    if (Object.is(prevVal, nextVal)) {
      return;
    }

    const oldVal = prevVal;
    prevVal = nextVal;

    const prevSub = setActiveSub(undefined);
    try {
      (listener as StoreListener<T>)(nextVal, oldVal);
    } finally {
      setActiveSub(prevSub);
    }
  });

  const unsubscribe = (() => {
    if (!active) return;
    active = false;
    stop();
  }) as Subscription;

  unsubscribe.unsubscribe = unsubscribe;
  return unsubscribe;
}

class StoreImpl<T> implements Store<T> {
  readonly [STORE_SYMBOL] = true as const;
  private readonly _initial: T;
  private readonly _raw: { (): T; (value: T): void };
  private _current: T;

  constructor(initialValue: T) {
    this._initial = initialValue;
    this._current = initialValue;
    this._raw = rawSignal<T>(initialValue);
  }

  get value(): T {
    return this._raw();
  }

  set value(next: T) {
    if (Object.is(this._current, next)) {
      return;
    }
    this._current = next;
    this._raw(next);
  }

  peek(): T {
    return this._current;
  }

  reset(): void {
    this.value = this._initial;
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
    return subscribeStore(() => this._raw(), listener, options);
  }
}

class DerivedStoreImpl<T> implements ReadonlyStore<T> {
  readonly [STORE_SYMBOL] = true as const;
  private readonly _raw: () => T;

  constructor(getter: (prev?: T) => T) {
    this._raw = rawComputed<T>(getter);
  }

  get value(): T {
    return this._raw();
  }

  peek(): T {
    const prevSub = setActiveSub(undefined);
    try {
      return this._raw();
    } finally {
      setActiveSub(prevSub);
    }
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
    return subscribeStore(() => this._raw(), listener, options);
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
