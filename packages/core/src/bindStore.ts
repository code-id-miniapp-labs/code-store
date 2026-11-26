import { diffSnapshot } from './diffSnapshot';
import {
  PAGE_HOOKED_KEY,
  notifyPageHide,
  notifyPageShow,
  notifyPageUnload,
  registerPageHandle,
  unregisterPageHandle,
  type PageLike,
} from './pageRegistry';
import {
  isStore,
  type AnyListener,
  type InternalSubscribable,
} from './store';
import type {
  BindStoreOptions,
  ReadonlyStore,
  SetDataCapableInstance,
  StoreBindingHandle,
  StoreBindings,
  TypedStoreBehavior,
} from './types';

const NOOP_HANDLE: StoreBindingHandle = {
  pause() {},
  resume() {},
  dispose() {},
};

let resolvedPromise: Promise<void> | undefined;
const dirtyFlushQueue: StoreBinding[] = [];
let microtaskScheduled = false;

function flushAllBindings(): void {
  let i = 0;
  try {
    while (i < dirtyFlushQueue.length) {
      const binding = dirtyFlushQueue[i]!;
      dirtyFlushQueue[i] = undefined as unknown as StoreBinding;
      i++;
      binding._inQueue = false;
      binding._flush();
    }
  } finally {
    for (; i < dirtyFlushQueue.length; i++) {
      const binding = dirtyFlushQueue[i];
      if (binding !== undefined) {
        binding._inQueue = false;
      }
    }
    dirtyFlushQueue.length = 0;
    microtaskScheduled = false;
  }
}

function enqueueBindingFlush(binding: StoreBinding): void {
  binding._inQueue = true;
  dirtyFlushQueue.push(binding);
  if (!microtaskScheduled) {
    microtaskScheduled = true;
    (resolvedPromise ??= Promise.resolve()).then(flushAllBindings);
  }
}

type StoredDetachHandle = AnyListener<unknown> | (() => void);

function isInternalStore(
  source: ReadonlyStore<unknown>
): source is ReadonlyStore<unknown> & InternalSubscribable<unknown> {
  return typeof (source as Partial<InternalSubscribable<unknown>>)._attach === 'function';
}

function attachStoreListener(
  source: ReadonlyStore<unknown>,
  listener: AnyListener<unknown>
): StoredDetachHandle {
  return isInternalStore(source)
    ? source._attach(listener)
    : source.subscribe(listener);
}

function detachStoreListener(
  source: ReadonlyStore<unknown>,
  handle: StoredDetachHandle
): void {
  if (isInternalStore(source)) {
    source._detach(handle as AnyListener<unknown>);
  } else {
    (handle as () => void)();
  }
}

function createFieldListener(
  binding: StoreBinding,
  idx: number
): AnyListener<unknown> {
  return (nextVal: unknown) => {
    binding._onUpdate(idx, nextVal);
  };
}

class StoreBinding implements StoreBindingHandle {
  private _target: SetDataCapableInstance | undefined;
  private readonly _keys: string[];
  private readonly _sources: Array<ReadonlyStore<unknown>>;
  readonly _listeners: Array<StoredDetachHandle | undefined>;
  readonly _committed: unknown[];
  private _pending: unknown[] | undefined = undefined;
  private _dirtyFlag: Uint8Array | undefined;
  private _dirtyMask = 0;
  private _dirtyIndices: number[] | undefined = undefined;
  private readonly _useDiff: boolean;
  private _disposed = false;
  private _paused = false;
  _inQueue = false;

  constructor(
    instance: SetDataCapableInstance,
    keys: string[],
    sources: Array<ReadonlyStore<unknown>>,
    useDiff: boolean
  ) {
    const len = keys.length;
    this._target = instance;
    this._keys = keys;
    this._sources = sources;
    this._listeners = new Array<StoredDetachHandle | undefined>(len);
    this._committed = new Array<unknown>(len);
    // Use an unboxed 31-bit Smi bitmask for <= 30 fields; fall back to Uint8Array above 30.
    this._dirtyFlag = len > 30 ? new Uint8Array(len) : undefined;
    this._useDiff = useDiff;
  }

  _onUpdate(idx: number, nextVal: unknown): void {
    if (this._disposed) {
      return;
    }

    const flag = this._dirtyFlag;
    const wasDirty =
      flag !== undefined ? flag[idx] === 1 : (this._dirtyMask & (1 << idx)) !== 0;
    const currentKnown = wasDirty
      ? this._pending![idx]
      : this._committed[idx];
    if (Object.is(currentKnown, nextVal)) {
      return;
    }

    let pending = this._pending;
    if (pending === undefined) {
      pending = new Array<unknown>(this._keys.length);
      this._pending = pending;
    }
    pending[idx] = nextVal;

    if (!wasDirty) {
      if (flag !== undefined) {
        flag[idx] = 1;
      } else {
        this._dirtyMask |= 1 << idx;
      }
      let indices = this._dirtyIndices;
      if (indices === undefined) {
        indices = [];
        this._dirtyIndices = indices;
      }
      indices.push(idx);
    }

    if (!this._paused && !this._inQueue) {
      enqueueBindingFlush(this);
    }
  }

  _flush(): void {
    const indices = this._dirtyIndices;
    if (
      this._disposed ||
      this._paused ||
      indices === undefined ||
      indices.length === 0
    ) {
      return;
    }

    const target = this._target;
    if (target === undefined) {
      return;
    }

    const pending = this._pending!;
    const committed = this._committed;
    const keys = this._keys;
    const flag = this._dirtyFlag;
    const useDiff = this._useDiff;

    const payload: Record<string, unknown> = {};
    let hasPayload = false;

    const count = indices.length;
    for (let j = 0; j < count; j++) {
      const idx = indices[j]!;
      if (flag !== undefined) {
        flag[idx] = 0;
      } else {
        this._dirtyMask &= ~(1 << idx);
      }

      const key = keys[idx]!;
      const prevVal = committed[idx];
      const nextVal = pending[idx];
      // Clear pending slot immediately so stale object/array references are not retained.
      pending[idx] = undefined;

      if (Object.is(prevVal, nextVal)) {
        continue;
      }

      committed[idx] = nextVal;

      if (useDiff) {
        if (diffSnapshot(prevVal, nextVal, key, payload)) {
          hasPayload = true;
        }
      } else {
        payload[key] = nextVal === undefined ? null : nextVal;
        hasPayload = true;
      }
    }

    indices.length = 0;

    if (hasPayload) {
      target.setData(payload);
    }
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    if (!this._paused || this._disposed) {
      return;
    }
    this._paused = false;
    if (this._dirtyIndices !== undefined && this._dirtyIndices.length > 0) {
      this._flush();
    }
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;

    const sources = this._sources;
    const listeners = this._listeners;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const handle = listeners[i];
      if (source !== undefined && handle !== undefined) {
        detachStoreListener(source, handle);
      }
    }

    listeners.length = 0;
    sources.length = 0;
    this._keys.length = 0;
    this._committed.length = 0;
    if (this._pending !== undefined) {
      this._pending.length = 0;
      this._pending = undefined;
    }
    if (this._dirtyIndices !== undefined) {
      this._dirtyIndices.length = 0;
      this._dirtyIndices = undefined;
    }
    if (this._dirtyFlag !== undefined) {
      this._dirtyFlag.fill(0);
      this._dirtyFlag = undefined;
    }
    this._dirtyMask = 0;
    this._target = undefined;
  }
}

interface MountedBinding {
  handle: StoreBindingHandle;
  hostPage: PageLike | undefined;
}

/** Binds reactive stores in `bindings` to a WeChat Page/Component (actions are ignored by `setData`). */
export function bindStore<B extends StoreBindings>(
  instance: SetDataCapableInstance,
  bindings: B,
  options?: BindStoreOptions
): StoreBindingHandle {
  const allKeys = Object.keys(bindings);
  const keys: string[] = [];
  const sources: Array<ReadonlyStore<unknown>> = [];

  for (let i = 0; i < allKeys.length; i++) {
    const k = allKeys[i];
    if (k === undefined) continue;
    const entry = bindings[k];
    if (isStore(entry)) {
      keys.push(k);
      sources.push(entry);
    }
  }

  const len = keys.length;
  if (len === 0) {
    return NOOP_HANDLE;
  }

  const useDiff = options?.diff ?? true;
  const binding = new StoreBinding(instance, keys, sources, useDiff);

  // Plain `{}` required because WeChat Exparser may call `hasOwnProperty`.
  // Kept strictly stack-local (never captured by closures) so mount snapshots GC immediately.
  const initialPatch: Record<string, unknown> = {};
  let hasInitialChanges = false;
  const existingData = instance.data;

  try {
    for (let i = 0; i < len; i++) {
      const key = keys[i]!;
      const source = sources[i]!;
      binding._listeners[i] = attachStoreListener(
        source,
        createFieldListener(binding, i)
      );

      const initialVal = source.peek();
      binding._committed[i] = initialVal;

      const isTopLevel = key.indexOf('.') === -1;
      const alreadyMatches =
        isTopLevel &&
        existingData !== undefined &&
        Object.is(existingData[key], initialVal);
      if (!alreadyMatches && initialVal !== undefined) {
        initialPatch[key] = initialVal;
        hasInitialChanges = true;
      }
    }
  } catch (err) {
    binding.dispose();
    throw err;
  }

  if (hasInitialChanges) {
    instance.setData(initialPatch);
  }

  return binding;
}

/** Creates an explicit, typed, stackable WeChat `Behavior` injecting `this.store` & `this.data`. */
export function bindStoreBehavior<B extends StoreBindings>(
  bindings: B,
  options?: BindStoreOptions
): TypedStoreBehavior<B> {
  const mounted = new WeakMap<SetDataCapableInstance, MountedBinding>();

  return Behavior({
    lifetimes: {
      created(this: SetDataCapableInstance) {
        this.store = this.store
          ? Object.assign({}, this.store, bindings)
          : bindings;
      },
      attached(this: PageLike) {
        if (!this.store) {
          this.store = bindings;
        }
        const handle = bindStore(this, bindings, options);
        const hostPage = registerPageHandle(this, handle);
        mounted.set(this, { handle, hostPage });
      },
      detached(this: PageLike) {
        const entry = mounted.get(this);
        if (entry) {
          unregisterPageHandle(entry.hostPage, entry.handle);
          entry.handle.dispose();
          mounted.delete(this);
        }
      },
    },
  }) as unknown as TypedStoreBehavior<B>;
}

const STORE_CONFIG_KEY = '__codeStoreConfig__';

interface StoreConfig {
  bindings: StoreBindings;
  options: BindStoreOptions;
}

interface StoreAwareInstance extends PageLike {
  storeOptions?: BindStoreOptions;
  [STORE_CONFIG_KEY]?: () => StoreConfig;
}

interface StoreDefinitionFields {
  store?: StoreBindings;
  storeOptions?: BindStoreOptions;
  properties?: Record<string, unknown>;
  lifetimes?: Record<string, unknown>;
  pageLifetimes?: Record<string, unknown>;
  relations?: Record<string, unknown>;
  observers?: Record<string, unknown>;
  methods?: Record<string, (...args: any[]) => any>;
  onLoad?: (
    this: StoreAwareInstance,
    query: Record<string, string | undefined>
  ) => any;
  onShow?: (this: StoreAwareInstance) => any;
  onHide?: (this: StoreAwareInstance) => any;
  onUnload?: (this: StoreAwareInstance) => any;
  [STORE_CONFIG_KEY]?: () => StoreConfig;
  [PAGE_HOOKED_KEY]?: boolean;
}

function isLikelyComponentDef(def: StoreDefinitionFields): boolean {
  return (
    def.properties !== undefined ||
    def.lifetimes !== undefined ||
    def.pageLifetimes !== undefined ||
    def.relations !== undefined ||
    def.observers !== undefined ||
    def.methods !== undefined
  );
}

/** Creates a declarative `definitionFilter` Behavior enabling `store: { ... }` + `this.store`. */
export function createStoreBehavior(defaultOptions?: BindStoreOptions): string {
  const mounted = new WeakMap<SetDataCapableInstance, MountedBinding>();

  function resolveConfig(instance: StoreAwareInstance): StoreConfig | undefined {
    const getter = instance[STORE_CONFIG_KEY];
    if (typeof getter === 'function') {
      return getter();
    }
    // Fallback when a native Page runtime (e.g. Skyline) skips `definitionFilter`.
    if (instance.store && Object.keys(instance.store).length > 0) {
      return {
        bindings: instance.store,
        options: { ...defaultOptions, ...instance.storeOptions },
      };
    }
    return undefined;
  }

  function ensureStoreRef(
    instance: StoreAwareInstance
  ): StoreConfig | undefined {
    const config = resolveConfig(instance);
    if (config && instance.store === undefined) {
      instance.store = config.bindings;
    }
    return config;
  }

  function mount(instance: StoreAwareInstance): void {
    if (mounted.has(instance)) {
      return;
    }
    const config = ensureStoreRef(instance);
    if (!config) {
      return;
    }
    const handle = bindStore(instance, config.bindings, config.options);
    const hostPage = registerPageHandle(instance, handle);
    mounted.set(instance, { handle, hostPage });
  }

  function unmount(instance: StoreAwareInstance): void {
    const entry = mounted.get(instance);
    if (entry) {
      unregisterPageHandle(entry.hostPage, entry.handle);
      entry.handle.dispose();
      mounted.delete(instance);
    }
  }

  return Behavior({
    definitionFilter(defFields: StoreDefinitionFields) {
      const bindings = defFields.store;
      if (!bindings || Object.keys(bindings).length === 0) {
        return;
      }

      const mergedOptions: BindStoreOptions = {
        ...defaultOptions,
        ...defFields.storeOptions,
      };
      const config: StoreConfig = { bindings, options: mergedOptions };
      const getStoreConfig = (): StoreConfig => config;

      if (isLikelyComponentDef(defFields)) {
        defFields.methods = defFields.methods || {};
        defFields.methods[STORE_CONFIG_KEY] = getStoreConfig;
        return;
      }

      defFields[STORE_CONFIG_KEY] = getStoreConfig;
      defFields[PAGE_HOOKED_KEY] = true;
      defFields.methods = defFields.methods || {};
      defFields.methods[STORE_CONFIG_KEY] = getStoreConfig;

      const origOnLoad = defFields.onLoad;
      const origOnShow = defFields.onShow;
      const origOnHide = defFields.onHide;
      const origOnUnload = defFields.onUnload;

      defFields.onLoad = function (
        this: StoreAwareInstance,
        query: Record<string, string | undefined>
      ) {
        mount(this);
        if (origOnLoad) {
          return origOnLoad.call(this, query);
        }
      };

      defFields.onShow = function (this: StoreAwareInstance) {
        notifyPageShow(this);
        mounted.get(this)?.handle.resume();
        if (origOnShow) {
          return origOnShow.call(this);
        }
      };

      defFields.onHide = function (this: StoreAwareInstance) {
        notifyPageHide(this);
        mounted.get(this)?.handle.pause();
        if (origOnHide) {
          return origOnHide.call(this);
        }
      };

      defFields.onUnload = function (this: StoreAwareInstance) {
        try {
          if (origOnUnload) {
            return origOnUnload.call(this);
          }
        } finally {
          notifyPageUnload(this);
          unmount(this);
        }
      };
    },
    lifetimes: {
      created(this: StoreAwareInstance) {
        ensureStoreRef(this);
      },
      attached(this: StoreAwareInstance) {
        mount(this);
      },
      detached(this: StoreAwareInstance) {
        unmount(this);
      },
    },
  });
}

/** Ready-to-use declarative store Behavior singleton. */
export const storeBehavior: string =
  typeof Behavior !== 'undefined'
    ? /*#__PURE__*/ createStoreBehavior()
    : '';
