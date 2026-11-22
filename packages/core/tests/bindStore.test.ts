import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createStore,
  isStore,
  batch,
  bindStore,
  bindStoreBehavior,
  createStoreBehavior,
  type SetDataCapableInstance,
} from '../dist/index.mjs';

interface MockBehaviorDef {
  definitionFilter?: (defFields: Record<string, any>) => void;
  lifetimes: {
    created?(this: SetDataCapableInstance): void;
    attached(this: SetDataCapableInstance): void;
    detached(this: SetDataCapableInstance): void;
  };
  pageLifetimes: {
    show(this: SetDataCapableInstance): void;
    hide(this: SetDataCapableInstance): void;
  };
}

function createMockInstance(initialData: Record<string, unknown> = {}) {
  const payloads: Record<string, unknown>[] = [];
  const instance: SetDataCapableInstance & { data: Record<string, unknown> } = {
    data: { ...initialData },
    setData(patch: Record<string, unknown>) {
      payloads.push({ ...patch });
      Object.assign(this.data, patch);
    },
  };
  return { instance, payloads };
}

function setupMockBehaviorRegistry() {
  const registry = new Map<string, MockBehaviorDef>();
  let seq = 0;

  (globalThis as unknown as { Behavior: unknown }).Behavior = (
    def: MockBehaviorDef
  ) => {
    const id = `behavior_${seq++}`;
    registry.set(id, def);
    return id;
  };

  return registry;
}

describe('createStore (base + derived), isStore, bindStore & createStoreBehavior', () => {
  it('brands writable & derived stores with isStore() and distinguishes action functions', () => {
    const count = createStore(1);
    const doubled = createStore(() => count.value * 2);
    const cumulative = createStore<number>((prev) => count.value + (prev ?? 0));
    const action = () => {
      count.value++;
    };

    assert.equal(isStore(count), true);
    assert.equal(isStore(doubled), true);
    assert.equal(isStore(action), false);
    assert.equal(isStore({ value: 1 }), false);

    assert.equal(doubled.value, 2);
    assert.equal(cumulative.value, 1);

    count.value = 3;
    assert.equal(doubled.value, 6);
    assert.equal(cumulative.value, 4);
    assert.equal(doubled.peek(), 6);
  });

  it('hydrates reactive stores in one setData call and ignores actions (never invoked or serialized)', () => {
    const theme = createStore('light');
    const count = createStore(5);
    const isBig = createStore(() => count.value > 3);
    let actionCalled = 0;
    const increment = () => {
      actionCalled += 1;
      count.value += 1;
    };

    const { instance, payloads } = createMockInstance({ theme: 'light' });
    const handle = bindStore(instance, { theme, count, isBig, increment });

    assert.equal(actionCalled, 0);
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0], { count: 5, isBig: true });
    handle.dispose();
  });

  it('patches ONLY exact primitive or nested diffSnapshot path and suppresses A->B->A cycles', async () => {
    const theme = createStore('light');
    const user = createStore({ name: 'Alice', stats: { likes: 10, followers: 20 } });
    const count = createStore(0);
    const doubled = createStore(() => count.value * 2);

    const { instance, payloads } = createMockInstance();
    const handle = bindStore(instance, { theme, user, count, doubled });
    payloads.length = 0;

    theme.value = 'dark';
    await Promise.resolve();
    assert.deepEqual(payloads[0], { theme: 'dark' });

    user.value = {
      ...user.peek(),
      stats: { ...user.peek().stats, likes: 11 },
    };
    await Promise.resolve();
    assert.deepEqual(payloads[1], { 'user.stats.likes': 11 });

    count.value = 5;
    count.value = 0;
    await Promise.resolve();
    assert.equal(payloads.length, 2);

    theme.reset();
    await Promise.resolve();
    assert.deepEqual(payloads[2], { theme: 'light' });

    handle.dispose();
  });

  it('allows disabling diffSnapshot (`diff: false`)', async () => {
    const user = createStore({ name: 'Alice', likes: 1 });
    const { instance, payloads } = createMockInstance();
    const handle = bindStore(instance, { user }, { diff: false });
    payloads.length = 0;

    user.value = { name: 'Alice', likes: 2 };
    await Promise.resolve();
    assert.deepEqual(payloads, [{ user: { name: 'Alice', likes: 2 } }]);
    handle.dispose();
  });

  it('coalesces multi-store batch() updates into a single setData', async () => {
    const a = createStore(1);
    const b = createStore(2);
    const sum = createStore(() => a.value + b.value);

    const { instance, payloads } = createMockInstance();
    const handle = bindStore(instance, { a, b, sum });
    payloads.length = 0;

    batch(() => {
      a.value = 10;
      b.value = 20;
    });

    await Promise.resolve();
    assert.equal(payloads.length, 1);
    assert.deepEqual(payloads[0], { a: 10, b: 20, sum: 30 });
    assert.equal(sum.peek(), 30);
    handle.dispose();
  });

  it('exposes both reactive stores AND actions on `this.store` via definitionFilter on Page & Component', async () => {
    const registry = setupMockBehaviorRegistry();
    const storeBehaviorId = createStoreBehavior();
    const behaviorDef = registry.get(storeBehaviorId);
    assert.ok(behaviorDef);

    const theme = createStore<'light' | 'dark'>('light');
    const count = createStore(0);
    const increment = (delta = 1) => {
      count.value += delta;
    };

    // 1. Standard Page invoking `this.store.increment()` and reading `this.store.theme.value`
    let seenThemeInOnLoad = '';
    const pageDef: Record<string, any> = {
      behaviors: [storeBehaviorId],
      store: { theme, count, increment },
      onLoad(this: any) {
        seenThemeInOnLoad = this.store.theme.value;
      },
    };
    behaviorDef.definitionFilter?.(pageDef);

    const pageMock = createMockInstance();
    const pageInstance: Record<string, any> = {
      ...pageMock.instance,
      store: pageDef.store,
      __codeStoreConfig__: pageDef.__codeStoreConfig__,
    };

    behaviorDef.lifetimes.attached.call(pageInstance as SetDataCapableInstance);
    pageDef.onLoad.call(pageInstance, {});
    assert.equal(seenThemeInOnLoad, 'light');
    // Only reactive stores sent to setData — `increment` is never serialized
    assert.deepEqual(pageMock.payloads, [{ theme: 'light', count: 0 }]);
    pageMock.payloads.length = 0;

    pageInstance.store.increment(2);
    await Promise.resolve();
    assert.deepEqual(pageMock.payloads, [{ count: 2 }]);
    pageMock.payloads.length = 0;

    pageDef.onHide.call(pageInstance);
    pageInstance.store.increment(1);
    pageInstance.store.increment(1);
    await Promise.resolve();
    assert.equal(pageMock.payloads.length, 0);

    pageDef.onShow.call(pageInstance);
    assert.deepEqual(pageMock.payloads, [{ count: 4 }]);
    pageMock.payloads.length = 0;

    pageDef.onUnload.call(pageInstance);
    count.value = 5;
    await Promise.resolve();
    assert.equal(pageMock.payloads.length, 0);

    // 2. Component invoking `this.store.increment()` and reading `this.store.count.peek()`
    const compDef: Record<string, any> = {
      behaviors: [storeBehaviorId],
      properties: { max: Number },
      store: { count, increment },
    };
    behaviorDef.definitionFilter?.(compDef);
    assert.equal(compDef.onLoad, undefined);

    const compMock = createMockInstance();
    const compInstance: Record<string, any> = {
      ...compMock.instance,
      ...compDef.methods,
    };

    behaviorDef.lifetimes.created?.call(compInstance as SetDataCapableInstance);
    assert.equal(compInstance.store.count, count);
    assert.equal(compInstance.store.increment, increment);

    behaviorDef.lifetimes.attached.call(compInstance as SetDataCapableInstance);
    assert.deepEqual(compMock.payloads, [{ count: 5 }]);
    compMock.payloads.length = 0;

    compInstance.store.increment(3);
    assert.equal(compInstance.store.count.peek(), 8);
    await Promise.resolve();
    assert.deepEqual(compMock.payloads, [{ count: 8 }]);

    behaviorDef.lifetimes.detached.call(compInstance as SetDataCapableInstance);
    count.value = 9;
    await Promise.resolve();
    assert.equal(compMock.payloads.length, 1);

    // 3. Skyline native Page fallback
    const skylineMock = createMockInstance();
    const skylinePage: SetDataCapableInstance = {
      ...skylineMock.instance,
      store: { theme },
    };
    behaviorDef.lifetimes.attached.call(skylinePage);
    assert.deepEqual(skylineMock.payloads, [{ theme: 'light' }]);
    behaviorDef.lifetimes.detached.call(skylinePage);
  });

  it('is a zero-overhead no-op in definitionFilter when `store` is omitted', () => {
    const registry = setupMockBehaviorRegistry();
    const storeBehaviorId = createStoreBehavior();
    const behaviorDef = registry.get(storeBehaviorId);
    assert.ok(behaviorDef);

    const plainDef: Record<string, any> = { data: { title: 'Static' } };
    behaviorDef.definitionFilter?.(plainDef);

    assert.deepEqual(Object.keys(plainDef), ['data']);
  });

  it('supports stacking multiple bindStoreBehavior instances and merges `this.store`', async () => {
    const registry = setupMockBehaviorRegistry();
    const theme = createStore('light');
    const count = createStore(0);
    const bump = () => {
      count.value += 1;
    };

    const defA = registry.get(bindStoreBehavior({ theme }));
    const defB = registry.get(bindStoreBehavior({ count, bump }));
    assert.ok(defA && defB);

    const { instance, payloads } = createMockInstance();
    defA.lifetimes.created?.call(instance);
    defB.lifetimes.created?.call(instance);
    assert.equal(instance.store?.theme, theme);
    assert.equal(instance.store?.count, count);
    assert.equal(instance.store?.bump, bump);

    defA.lifetimes.attached.call(instance);
    defB.lifetimes.attached.call(instance);
    payloads.length = 0;

    theme.value = 'dark';
    instance.store?.bump();
    await Promise.resolve();
    assert.deepEqual(payloads, [{ theme: 'dark' }, { count: 1 }]);

    defA.lifetimes.detached.call(instance);
    defB.lifetimes.detached.call(instance);
    theme.value = 'light';
    count.value = 10;
    await Promise.resolve();
    assert.equal(payloads.length, 2);
  });

  it('loads and executes cleanly via the CommonJS build', () => {
    const require = createRequire(import.meta.url);
    const cjs = require('../dist/index.cjs') as typeof import('../dist/index.mjs');

    const count = cjs.createStore(2);
    const tripled = cjs.createStore(() => count.value * 3);
    const { instance, payloads } = createMockInstance();

    const handle = cjs.bindStore(instance, { count, tripled });
    assert.deepEqual(payloads, [{ count: 2, tripled: 6 }]);
    handle.dispose();
  });
});
