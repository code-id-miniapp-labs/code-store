export const STORE_SYMBOL: unique symbol = Symbol.for(
  'code-store.store'
) as never;

export interface PersistentStoreOptions {
  /** Debounce delay (ms) before persisting. Defaults to `0` (`wx.nextTick` coalescing). */
  debounceMs?: number;
  /** Optional handler when WeChat storage read/write fails. */
  onError?: (error: unknown) => void;
}

export interface SubscribeOptions {
  /** Invoke listener immediately with the current value. Defaults to `false`. */
  immediate?: boolean;
}

export type StoreListener<T> = (value: T, prevValue: T) => void;

export type ImmediateStoreListener<T> = (
  value: T,
  prevValue: T | undefined
) => void;

export interface Subscription {
  (): void;
  unsubscribe: () => void;
}

export interface ReadonlyStore<T> {
  readonly [STORE_SYMBOL]: true;
  readonly value: T;
  /** Read without subscribing to the active effect or derived store. */
  peek(): T;
  /** Subscribe to value changes. Returns a callable unsubscribe function (also destructurable as `{ unsubscribe }`). */
  subscribe(listener: StoreListener<T>): Subscription;
  subscribe(
    listener: ImmediateStoreListener<T>,
    options: { immediate: true }
  ): Subscription;
  subscribe(
    listener: StoreListener<T>,
    options?: { immediate?: false }
  ): Subscription;
}

export interface Store<T> extends ReadonlyStore<T> {
  value: T;
  /** Reset back to the initial value. */
  reset(): void;
}

export interface PersistentStore<T> extends Store<T> {
  /** Reset to `defaultValue` and remove the key from WeChat storage. */
  clear(): void;
}

export type StoreAction = (...args: any[]) => any;

/** Reactive store (synced to `this.data`) or action function (callable on `this.store`). */
export type StoreEntry = ReadonlyStore<any> | StoreAction;

export type StoreBindings = Record<string, StoreEntry>;

/** Extracts only reactive store values into their `this.data` types (excludes actions). */
export type ExtractStoreData<B extends StoreBindings> = {
  [K in keyof B as B[K] extends ReadonlyStore<any> ? K : never]: B[K] extends ReadonlyStore<infer V>
    ? V
    : never;
};

/** Typed WeChat Behavior identifier carrying `this.data` & `this.store` types for `Component()`. */
export type TypedStoreBehavior<B extends StoreBindings> = string & {
  BehaviorType?: {
    data: ExtractStoreData<B>;
    methods: { store: B };
  };
};

export interface BindStoreOptions {
  /** Diff non-primitive updates into WeChat path patches. Defaults to `true`. */
  diff?: boolean;
}

export interface StoreBindingHandle {
  pause(): void;
  resume(): void;
  dispose(): void;
}

export interface SetDataCapableInstance {
  data?: Record<string, unknown>;
  setData(data: Record<string, unknown>, callback?: () => void): void;
  store?: Record<string, any>;
}

declare global {
  namespace WechatMiniprogram {
    namespace Component {
      interface OtherOption {
        store?: StoreBindings;
        storeOptions?: BindStoreOptions;
      }
      interface InstanceProperties {
        store: Record<string, any>;
      }
    }
  }
}
