# @code-id-labs/store

## 1.1.0

### Minor Changes

- ac1027a: Re-export `setActiveSub` from `alien-signals` and significantly reduce memory footprint and subscription overhead across `createStore`, `createPersistentStore`, and `bindStore`:

  - **Direct listener dispatch & shared batching**: Writable and persistent stores now track subscribers directly (`undefined` -> single function -> `Set`) with a single shared batch-flush effect, eliminating per-subscription `alien-signals` `EffectNode`/`Link` allocations. Derived stores share a single lazy `effect` across all subscribers and tear it down when unwatched.
  - **Lazy signal/computed materialization**: `createStore` and `createPersistentStore` defer allocating underlying `alien-signals` nodes until reactively tracked, move `[STORE_SYMBOL]` onto the prototype, and avoid leaking upstream links on unwatched derived `.peek()` calls.
  - **Zero-retention cleanup & `bindStore` optimization**: `unsubscribe()` and `bindStore.dispose()` immediately release closed-over references; `bindStore` uses a `StoreBinding` class with a 31-bit Smi dirty bitmask (<=30 fields), clears `pending` slots on flush, avoids retaining `initialPatch`, and batches all dirty bindings onto a single shared microtask flush queue (~58–66% lower heap usage and up to 2.3x faster subscribe/lifecycle throughput).

## 1.0.1

### Patch Changes

- a88f016: Remove per-component `pageLifetimes` from `storeBehavior` and `bindStoreBehavior` to prevent WeChat MiniProgram / TCMPP `onBeforeUnloadPage_<webviewId>` listener leak warnings when mounting 20+ store-connected components on a page. Component handles are now registered in a `WeakMap`-backed per-page registry and fanned out once per page via `onShow` / `onHide` / `onUnload`.

## 1.0.0

### Major Changes

- 7cffbc5: Initial release of `@code-id-labs/store` — zero-overhead atomic state management for WeChat MiniPrograms powered by `alien-signals`.

  ### Highlights

  - **Atomic `.value` stores**: `createStore(initialValue)` for writable stores, `createStore((prev?) => ...)` for lazy derived stores, `batch()`, `isStore()`, and TanStack-style `.subscribe()` (returning a callable/destructurable `unsubscribe`).
  - **Lazy persistent stores**: `createPersistentStore(key, defaultValue, { debounceMs?, onError? })` with lazy `wx.getStorageSync` hydration, `wx.nextTick` coalescing, `wx.batchSetStorage` batching, and automatic `wx.onAppHide` sync flushing.
  - **WeChat lifecycle & `setData` optimization**: `storeBehavior` / `createStoreBehavior` (`definitionFilter` enabling declarative `store: { ... }` + `this.store`), `bindStoreBehavior`, `bindStore` (fixed indexed arrays + `Uint8Array` dirty bitmap), and zero-allocation `diffSnapshot` for minimal dot/bracket-path `setData` payloads.
