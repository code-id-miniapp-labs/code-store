# `code-store`

Zero-overhead **Atomic Store** state management for WeChat Miniapps powered by [`alien-signals`](https://github.com/stackblitz/alien-signals), bundled with [`tsdown`](https://tsdown.dev/) in a `pnpm` workspace.

## Highlights

- **Minimal TanStack-Style API** — `createStore(value)` for writable stores, `createStore(() => ...)` for lazy derived stores, `createPersistentStore(key, defaultValue)` for persisted stores, and `batch()`.
- **Zero Cold-Start Storage Cost** — Lazy hydration on first read, multi-key batching via `wx.batchSetStorage` (≥ 2.25.0), and automatic background flush via `wx.onAppHide` (≥ 2.1.2).
- **Zero-Allocation `setData` Pipeline** — Fixed indexed arrays + `Uint8Array` dirty bitmap + zero-allocation `diffSnapshot` emitting minimal WeChat paths (`'profile.stats.points'`, `'items[0].qty'`).
- **Seamless `code-ui` Pairing** — `storeBehavior` (`definitionFilter`) enables declarative `store: { ... }` + `this.store` on `Page()` and `Component()`, merging with `code-ui`'s `computedBehavior` in a single `setData` call.

## Quick Start

```ts
import {
  createStore,
  createPersistentStore,
  batch,
  storeBehavior,
} from 'code-store';
import { createPageOptions, createComponentOptions } from '@code-id-labs/miniapp';

export const themeStore = createPersistentStore<'light' | 'dark'>('app:theme', 'light');
export const cartCountStore = createStore(0);
export const formattedTotalStore = createStore(
  () => `¥${(cartCountStore.value * 29.9).toFixed(2)}`
);

Page(
  createPageOptions({
    behaviors: [storeBehavior],
    store: {
      theme: themeStore,
      cartCount: cartCountStore,
      formattedTotal: formattedTotalStore,
    },
    onIncrement() {
      this.store.cartCount.value++;
    },
    onReset() {
      batch(() => {
        cartCountStore.reset();
        themeStore.reset();
      });
    },
  })
);

Component(
  createComponentOptions({
    behaviors: [storeBehavior],
    store: { count: cartCountStore },
  })
);
```

## Scripts

```bash
pnpm install     # Install workspace dependencies
pnpm build       # Build packages/core via tsdown (ESM + CJS + dts)
pnpm test        # Build and run all unit tests
pnpm typecheck   # Strict TypeScript check (incl. exactOptionalPropertyTypes)
```
