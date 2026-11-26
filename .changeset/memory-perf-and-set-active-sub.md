---
"@code-id-labs/store": minor
---

Re-export `setActiveSub` from `alien-signals` and significantly reduce memory footprint and subscription overhead across `createStore`, `createPersistentStore`, and `bindStore`:

- **Direct listener dispatch & shared batching**: Writable and persistent stores now track subscribers directly (`undefined` -> single function -> `Set`) with a single shared batch-flush effect, eliminating per-subscription `alien-signals` `EffectNode`/`Link` allocations. Derived stores share a single lazy `effect` across all subscribers and tear it down when unwatched.
- **Lazy signal/computed materialization**: `createStore` and `createPersistentStore` defer allocating underlying `alien-signals` nodes until reactively tracked, move `[STORE_SYMBOL]` onto the prototype, and avoid leaking upstream links on unwatched derived `.peek()` calls.
- **Zero-retention cleanup & `bindStore` optimization**: `unsubscribe()` and `bindStore.dispose()` immediately release closed-over references; `bindStore` uses a `StoreBinding` class with a 31-bit Smi dirty bitmask (<=30 fields), clears `pending` slots on flush, avoids retaining `initialPatch`, and batches all dirty bindings onto a single shared microtask flush queue (~58–66% lower heap usage and up to 2.3x faster subscribe/lifecycle throughput).
