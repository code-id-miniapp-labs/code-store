# `code-store`

Zero-overhead **Atomic Store** state management for WeChat Miniapps powered by [`alien-signals`](https://github.com/stackblitz/alien-signals).

## Quick Start

```ts
import {
  createStore,
  createPersistentStore,
  storeBehavior,
} from 'code-store';

export const themeStore = createPersistentStore<'light' | 'dark'>('app:theme', 'light');
export const cartCountStore = createStore(0);
export const totalCentsStore = createStore(() => cartCountStore.value * 2990);

Page({
  behaviors: [storeBehavior],
  store: {
    theme: themeStore,
    cartCount: cartCountStore,
    totalCents: totalCentsStore,
  },
  onIncrement() {
    this.store.cartCount.value++;
  },
});
```

## Public API

- `createStore(initialValue)` — Writable atomic store (`.value`, `.peek()`, `.reset()`, `.subscribe()`)
- `createStore((prev?) => value)` — Lazy cached read-only derived store (`.value`, `.peek()`, `.subscribe()`)
- `createPersistentStore(key, defaultValue, { debounceMs?, onError? })` — Lazy-hydrated persistent store with `wx.nextTick` + `wx.batchSetStorage` + automatic `wx.onAppHide` sync flush (`.value`, `.peek()`, `.reset()`, `.clear()`, `.subscribe()`)
- `store.subscribe((val, prev) => {}, { immediate? })` — Returns a callable `unsubscribe` function (also supports `const { unsubscribe } = store.subscribe(...)`)
- `isStore(value)` — Runtime check distinguishing reactive stores from action functions
- `batch(fn)` — Atomic multi-store transaction
- `storeBehavior` / `createStoreBehavior({ diff? })` — Declarative `definitionFilter` Behavior enabling `store: { ... }` + `this.store`
- `bindStoreBehavior(bindings, { diff? })` — Explicit stackable Behavior (`WeakMap`-backed)
- `bindStore(instance, bindings, { diff? })` — Low-level binding engine
- `diffSnapshot(prev, next, path, out)` — Standalone WeChat path differ
- `effect`, `effectScope`, `startBatch`, `endBatch` — Re-exported from `alien-signals`
