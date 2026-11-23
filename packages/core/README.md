# `@code-id-labs/store`

Atomic state management for WeChat MiniPrograms built on [`alien-signals`](https://github.com/stackblitz/alien-signals).

## Installation

```bash
npm install @code-id-labs/store
# or
pnpm add @code-id-labs/store
```

If you are not using a bundler (`weapp-vite`, Webpack, etc.), run **Tools → Build npm** in WeChat DevTools after installing.

## Usage

### 1. Define Stores (`store/cart.ts`)

```ts
import {
  createStore,
  createPersistentStore,
  batch,
} from '@code-id-labs/store';

export const themeStore = createPersistentStore<'light' | 'dark'>('app:theme', 'light');
export const discountStore = createPersistentStore('app:discount', 1.0);
export const noteStore = createPersistentStore('app:note', '', { debounceMs: 300 });

export const cartCountStore = createStore(0);
export const unitPriceCentsStore = createStore(2990);
export const profileStore = createStore({
  name: 'Guest',
  stats: { points: 100 },
});

export const totalCentsStore = createStore(() =>
  Math.round(cartCountStore.value * unitPriceCentsStore.value * discountStore.value)
);
export const formattedTotalStore = createStore(
  () => `¥${(totalCentsStore.value / 100).toFixed(2)}`
);

export function increment() {
  cartCountStore.value++;
}

export function earnPoints(points: number) {
  const prev = profileStore.peek();
  profileStore.value = {
    ...prev,
    stats: { ...prev.stats, points: prev.stats.points + points },
  };
}

export function resetAll() {
  batch(() => {
    cartCountStore.reset();
    discountStore.reset();
    noteStore.clear();
  });
}
```

### 2. Bind to a Page (`pages/cart/index.ts`)

```ts
import { storeBehavior } from '@code-id-labs/store';
import {
  themeStore,
  cartCountStore,
  formattedTotalStore,
  profileStore,
  increment,
  earnPoints,
  resetAll,
} from '../../store/cart';

Page({
  behaviors: [storeBehavior],

  store: {
    theme: themeStore,
    cartCount: cartCountStore,
    formattedTotal: formattedTotalStore,
    profile: profileStore,
    increment,
    earnPoints,
    resetAll,
  },

  onIncrement() {
    this.store.increment();
  },

  onEarnPoints() {
    this.store.earnPoints(50);
  },

  onReset() {
    this.store.resetAll();
  },
});
```

### 3. Bind to a Component (`components/cart-badge/index.ts`)

```ts
import { storeBehavior } from '@code-id-labs/store';
import { cartCountStore } from '../../store/cart';

Component({
  behaviors: [storeBehavior],

  store: {
    count: cartCountStore,
  },

  methods: {
    onTap() {
      if (this.store.count.peek() === 0) return;
      wx.navigateTo({ url: '/pages/checkout/index' });
    },
  },
});
```

### 4. Subscribe Outside Pages / Components

```ts
const unsubscribe = cartCountStore.subscribe((value, prevValue) => {
  console.log(`${prevValue} -> ${value}`);
});

unsubscribe();
```

`subscribe` also supports `{ immediate: true }` and `const { unsubscribe } = store.subscribe(...)`.

## API Reference

### `createStore(initialValue)`

Creates a writable store backed by `alien-signals`.

```ts
const count = createStore(0);
```

- `count.value` — read (tracked) or write (`Object.is` equal writes are ignored).
- `count.peek()` — read without subscribing the active `effect` or derived store.
- `count.reset()` — reset `.value` back to `initialValue`.
- `count.subscribe(listener, options?)` — listen to changes (see [`subscribe`](#storesubscribelistener-options)).

---

### `createStore(getter)`

Creates a lazy, cached read-only derived store. Recomputes only when dependencies read inside `getter` change.

```ts
const doubled = createStore(() => count.value * 2);

// Optional `prev` receives the previous computed value
const runningSum = createStore<number>((prev) => count.value + (prev ?? 0));
```

- `derived.value` — read (tracked).
- `derived.peek()` — read without subscribing.
- `derived.subscribe(listener, options?)` — listen to derived changes.

---

### `createPersistentStore(key, defaultValue, options?)`

Creates a writable store persisted in WeChat local storage.

```ts
const draft = createPersistentStore('app:draft', '', {
  debounceMs: 300,
  onError: (err) => console.error(err),
});
```

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `debounceMs` | `number` | `0` | Trailing debounce (ms) before persisting. When `0`, writes coalesce until `wx.nextTick` (falling back to microtask). |
| `onError` | `(error: unknown) => void` | `undefined` | Called if storage read/write fails (e.g., 10 MB quota exceeded). |

Behavior:
- **Lazy hydration**: `wx.getStorageSync(key)` runs only on the first `.value` / `.peek()` read (skipped if written before read).
- **Batched writes**: multiple dirty keys flush together via `wx.batchSetStorage` (Base Library ≥ 2.25.0), falling back to `wx.setStorage`.
- **Automatic background flush**: lazily registers one `wx.onAppHide` listener (Base Library ≥ 2.1.2) on first write to flush pending queued/debounced writes via `wx.batchSetStorageSync`.
- **Methods**: `.value`, `.peek()`, `.reset()` (persists `defaultValue`), `.clear()` (resets to `defaultValue` and calls `wx.removeStorage`), `.subscribe()`.

---

### `store.subscribe(listener, options?)`

Subscribes to any writable, derived, or persistent store. Does not fire immediately by default. Reading other stores inside `listener` does not create extra subscriptions.

```ts
// Callable unsubscribe
const unsubscribe = count.subscribe((value, prevValue) => {
  console.log(prevValue, '->', value);
});
unsubscribe();

// Destructured unsubscribe + immediate initial call (`prevValue` is `undefined` on first call)
const { unsubscribe: stop } = count.subscribe(
  (value, prevValue) => console.log(value, prevValue),
  { immediate: true }
);
stop();
```

---

### `batch(fn)`

Groups multiple store updates so derived stores, subscribers, `setData`, and storage writes flush once after `fn` returns.

```ts
batch(() => {
  cartCountStore.value = 0;
  discountStore.value = 1.0;
});
```

---

### `storeBehavior` / `createStoreBehavior(options?)`

Declarative `definitionFilter` Behavior for `Page()` and `Component()`.

```ts
// Ready-to-use singleton (diff: true)
Page({
  behaviors: [storeBehavior],
  store: {
    count: cartCountStore, // reactive store -> synced to this.data.count & this.store.count
    increment,             // plain function -> available on this.store.increment (never sent to setData)
  },
  storeOptions: { diff: true }, // optional per-page/component override
});

// Or create a custom instance with default options
const noDiffBehavior = createStoreBehavior({ diff: false });
```

- Injects `this.store` on both `Page` and `Component` (outside `this.data`).
- Pages/components without a `store` field incur zero hooks and zero overhead.
- Does **not** declare `pageLifetimes` on components — child handles register in a `WeakMap`-backed per-page registry and fan out `pause()` / `resume()` once per page on `onHide` / `onShow` (avoiding WeChat's `onBeforeUnloadPage` listener leak warning with 20+ components).

---

### `bindStoreBehavior(bindings, options?)`

Creates an explicit, stackable Behavior with inferred `this.store` and `this.data` types for `Component()`.

```ts
const cartBehavior = bindStoreBehavior({
  count: cartCountStore,
  increment,
});

Component({
  behaviors: [cartBehavior],
  methods: {
    onTap() {
      this.store.increment();
      console.log(this.data.count);
    },
  },
});
```

Multiple `bindStoreBehavior`s can be stacked on the same component; their `this.store` entries are merged automatically.

---

### `bindStore(instance, bindings, options?)`

Low-level imperative binding engine.

```ts
const handle = bindStore(this, { count: cartCountStore }, { diff: true });
handle.pause();   // defer setData while hidden
handle.resume();  // flush latest delta immediately
handle.dispose(); // stop effectScope and release references
```

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `diff` | `boolean` | `true` | Diff non-primitive updates into WeChat dot/bracket paths via `diffSnapshot`. Primitives always bypass diffing in O(1). |

---

### `diffSnapshot(prev, next, path, out)`

Standalone WeChat `setData` path differ. Writes minimal patches into `out` and returns `true` if anything changed.

```ts
const out: Record<string, unknown> = {};
diffSnapshot(
  { stats: { points: 100 } },
  { stats: { points: 150 } },
  'profile',
  out
);
// out => { 'profile.stats.points': 150 }
```

- Emits dot-paths for nested objects and bracket-paths (`items[0].qty`) for arrays.
- Falls back to replacing the parent path (with `undefined` stripped) when keys are deleted, arrays shrink, or keys contain `.`, `[`, or `]`.
- Maps `undefined` transitions to `null` so WeChat WXML clears stale values.

---

### Utilities & Low-Level Re-Exports

- `isStore(value)` — returns `true` for stores created by `createStore` or `createPersistentStore` (used to distinguish stores from action functions).
- `effect`, `effectScope`, `startBatch`, `endBatch` — re-exported directly from `alien-signals`.

## Benchmarks

Measured against `mobx-miniprogram@6.12.3` + `mobx-miniprogram-bindings@4.0.1` using Vitest Bench (`pnpm bench`) and esbuild production bundling (`pnpm compare:size`) on Node 24.

### Speedup vs `mobx-miniprogram` (Higher is Better)

```text
Nested object setData  ████████████████████████████████████████  20.95x
Cold-start creation    ██████████████████████                    11.44x
Subscribe / Unsub      ███████████████                            7.85x
Subscribe + notify     ████████████                               6.22x
Page mount / dispose   █████████                                  4.61x
Batched 5-field        ███████                                    3.70x
Single-field setData   █████                                      2.52x
10-component fan-out   ████                                       2.04x
```

| Scenario | `@code-id-labs/store` (ops/s) | `mobx-miniprogram` (ops/s) | Speedup |
| :--- | ---: | ---: | ---: |
| Cold-start creation (50 fields + 10 derived) | 321,250 | 28,614 | 11.44× |
| Single primitive update → `setData` (20 bound fields) | 3,036,409 | 1,204,671 | 2.52× |
| Batched 5-field update + derived → `setData` | 1,015,839 | 292,566 | 3.70× |
| Nested object leaf mutation → `setData` | 1,218,580 | 59,184 | 20.95× |
| Page lifecycle churn (mount + dispose 10 fields) | 528,987 | 114,681 | 4.61× |
| Multi-component fan-out (10 subscribers) | 296,119 | 145,334 | 2.04× |
| Direct subscribe + notify (`subscribe` vs `reaction`) | 13,037,847 | 2,097,373 | 6.22× |
| Subscribe + unsubscribe churn | 10,558,347 | 1,344,257 | 7.85× |

### Bundle Size (Minified + Bundled Dependencies)

```text
@code-id-labs/store (min)   ███████                               3.09 kB gzip
@code-id-labs/store (full)  ██████████                            4.58 kB gzip
mobx-miniprogram + bindings ████████████████████████████████████ 18.18 kB gzip
```

| Package | Minified | Gzip (lv9) | Brotli |
| :--- | ---: | ---: | ---: |
| `@code-id-labs/store` (minimal: `createStore` + `batch` + `bindStore`) | 8.30 kB | 3.09 kB | 2.86 kB |
| `@code-id-labs/store` (full) | 13.15 kB | 4.58 kB | 4.22 kB |
| `mobx-miniprogram` + `mobx-miniprogram-bindings` | 57.97 kB | 18.18 kB | 16.18 kB |

### `setData` Payload Size

| Scenario | `@code-id-labs/store` | `mobx-miniprogram` | Reduction |
| :--- | :--- | ---: | ---: |
| Nested object leaf (`profile.stats.points`) | 29 B (`{"profile.stats.points":1001}`) | 337 B | 91.4% |
| Array item leaf (`cart[0].qty`) | 17 B (`{"cart[0].qty":2}`) | 371 B | 95.4% |
