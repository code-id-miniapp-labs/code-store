import { effect, effectScope } from 'alien-signals';
import { diffSnapshot } from './diffSnapshot';
import { isStore } from './store';
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

  let initializing = true;
  let disposed = false;
  let paused = false;
  let scheduled = false;

  const committed = new Array<unknown>(len);
  const pending = new Array<unknown>(len);
  const dirtyFlag = new Uint8Array(len);
  const dirtyIndices: number[] = [];

  // Plain `{}` required because WeChat Exparser may call `hasOwnProperty`.
  const initialPatch: Record<string, unknown> = {};
  let hasInitialChanges = false;

  function flush(): void {
    scheduled = false;
    if (disposed || paused || dirtyIndices.length === 0) {
      return;
    }

    const payload: Record<string, unknown> = {};
    let hasPayload = false;

    const count = dirtyIndices.length;
    for (let j = 0; j < count; j++) {
      const idx = dirtyIndices[j];
      if (idx === undefined) continue;
      dirtyFlag[idx] = 0;

      const key = keys[idx];
      if (key === undefined) continue;

      const prevVal = committed[idx];
      const nextVal = pending[idx];
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

    dirtyIndices.length = 0;

    if (hasPayload) {
      instance.setData(payload);
    }
  }

  const stopScope = effectScope(() => {
    for (let i = 0; i < len; i++) {
      const key = keys[i];
      const source = sources[i];
      if (key === undefined || !source) continue;

      let hasPrev = false;
      let prevSeen: unknown;

      effect(() => {
        const nextVal = source.value;
        if (hasPrev && Object.is(prevSeen, nextVal)) {
          return;
        }

        prevSeen = nextVal;
        hasPrev = true;

        if (initializing) {
          committed[i] = nextVal;
          const isTopLevel = key.indexOf('.') === -1;
          const alreadyMatches =
            isTopLevel &&
            instance.data !== undefined &&
            Object.is(instance.data[key], nextVal);
          if (!alreadyMatches && nextVal !== undefined) {
            initialPatch[key] = nextVal;
            hasInitialChanges = true;
          }
          return;
        }

        if (disposed) {
          return;
        }

        pending[i] = nextVal;
        if (dirtyFlag[i] === 0) {
          dirtyFlag[i] = 1;
          dirtyIndices.push(i);
        }

        if (!paused && !scheduled) {
          scheduled = true;
          Promise.resolve().then(flush);
        }
      });
    }
  });

  initializing = false;

  if (hasInitialChanges) {
    instance.setData(initialPatch);
  }

  return {
    pause(): void {
      paused = true;
    },
    resume(): void {
      if (!paused || disposed) {
        return;
      }
      paused = false;
      if (dirtyIndices.length > 0) {
        flush();
      }
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      dirtyIndices.length = 0;
      dirtyFlag.fill(0);
      committed.length = 0;
      pending.length = 0;
      stopScope();
    },
  };
}

/** Creates an explicit, typed, stackable WeChat `Behavior` injecting `this.store` & `this.data`. */
export function bindStoreBehavior<B extends StoreBindings>(
  bindings: B,
  options?: BindStoreOptions
): TypedStoreBehavior<B> {
  const handles = new WeakMap<SetDataCapableInstance, StoreBindingHandle>();

  return Behavior({
    lifetimes: {
      created(this: SetDataCapableInstance) {
        this.store = this.store
          ? Object.assign({}, this.store, bindings)
          : bindings;
      },
      attached(this: SetDataCapableInstance) {
        if (!this.store) {
          this.store = bindings;
        }
        handles.set(this, bindStore(this, bindings, options));
      },
      detached(this: SetDataCapableInstance) {
        const handle = handles.get(this);
        if (handle) {
          handle.dispose();
          handles.delete(this);
        }
      },
    },
    pageLifetimes: {
      show(this: SetDataCapableInstance) {
        handles.get(this)?.resume();
      },
      hide(this: SetDataCapableInstance) {
        handles.get(this)?.pause();
      },
    },
  }) as unknown as TypedStoreBehavior<B>;
}

const STORE_CONFIG_KEY = '__codeStoreConfig__';

interface StoreConfig {
  bindings: StoreBindings;
  options: BindStoreOptions;
}

interface StoreAwareInstance extends SetDataCapableInstance {
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
  const handles = new WeakMap<SetDataCapableInstance, StoreBindingHandle>();

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
    if (handles.has(instance)) {
      return;
    }
    const config = ensureStoreRef(instance);
    if (!config) {
      return;
    }
    handles.set(instance, bindStore(instance, config.bindings, config.options));
  }

  function unmount(instance: StoreAwareInstance): void {
    const handle = handles.get(instance);
    if (handle) {
      handle.dispose();
      handles.delete(instance);
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
        handles.get(this)?.resume();
        if (origOnShow) {
          return origOnShow.call(this);
        }
      };

      defFields.onHide = function (this: StoreAwareInstance) {
        handles.get(this)?.pause();
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
    pageLifetimes: {
      show(this: StoreAwareInstance) {
        handles.get(this)?.resume();
      },
      hide(this: StoreAwareInstance) {
        handles.get(this)?.pause();
      },
    },
  });
}

/** Ready-to-use declarative store Behavior singleton. */
export const storeBehavior: string =
  typeof Behavior !== 'undefined'
    ? /*#__PURE__*/ createStoreBehavior()
    : '';
