# @code-id-labs/store

## 1.0.0

### Major Changes

- 7cffbc5: Initial release of `@code-id-labs/store` — zero-overhead atomic state management for WeChat MiniPrograms powered by `alien-signals`.

  ### Highlights

  - **Atomic `.value` stores**: `createStore(initialValue)` for writable stores, `createStore((prev?) => ...)` for lazy derived stores, `batch()`, `isStore()`, and TanStack-style `.subscribe()` (returning a callable/destructurable `unsubscribe`).
  - **Lazy persistent stores**: `createPersistentStore(key, defaultValue, { debounceMs?, onError? })` with lazy `wx.getStorageSync` hydration, `wx.nextTick` coalescing, `wx.batchSetStorage` batching, and automatic `wx.onAppHide` sync flushing.
  - **WeChat lifecycle & `setData` optimization**: `storeBehavior` / `createStoreBehavior` (`definitionFilter` enabling declarative `store: { ... }` + `this.store`), `bindStoreBehavior`, `bindStore` (fixed indexed arrays + `Uint8Array` dirty bitmap), and zero-allocation `diffSnapshot` for minimal dot/bracket-path `setData` payloads.
