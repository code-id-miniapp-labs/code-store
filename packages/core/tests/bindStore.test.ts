import { describe, it, afterEach } from 'node:test';
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
  pageLifetimes?: Record<string, unknown>;
}

interface MockPageInstance extends SetDataCapableInstance {
  data: Record<string, unknown>;
  getPageId?: () => string;
  __wxWebviewId__?: number;
  onLoad?: (query?: Record<string, string | undefined>) => void;
  onShow?: () => void;
  onHide?: () => void;
  onUnload?: () => void;
  [key: string]: any;
}

function createMockInstance(
  initialData: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  const payloads: Record<string, unknown>[] = [];
  const instance: MockPageInstance = {
    data: { ...initialData },
    setData(patch: Record<string, unknown>) {
      payloads.push({ ...patch });
      Object.assign(this.data, patch);
    },
    ...extra,
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

function setupMockPageStack(pages: MockPageInstance[]) {
  (globalThis as unknown as { getCurrentPages: unknown }).getCurrentPages = () =>
    pages;
}

afterEach(() => {
  delete (globalThis as unknown as { getCurrentPages?: unknown }).getCurrentPages;
});

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

  it('does NOT declare pageLifetimes on storeBehavior or bindStoreBehavior (prevents onBeforeUnloadPage leak warning)', () => {
    const registry = setupMockBehaviorRegistry();
    const count = createStore(0);

    const storeBehaviorDef = registry.get(createStoreBehavior());
    const bindBehaviorDef = registry.get(bindStoreBehavior({ count }));
    assert.ok(storeBehaviorDef && bindBehaviorDef);

    assert.equal('pageLifetimes' in storeBehaviorDef, false);
    assert.equal('pageLifetimes' in bindBehaviorDef, false);
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
      __codeStorePageHooked__: pageDef.__codeStorePageHooked__,
    };

    behaviorDef.lifetimes.attached.call(pageInstance as SetDataCapableInstance);
    pageDef.onLoad.call(pageInstance, {});
    assert.equal(seenThemeInOnLoad, 'light');
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

  it('fans out onHide/onShow once per page to 25+ child components without double-patching', async () => {
    const registry = setupMockBehaviorRegistry();
    const count = createStore(0);
    const theme = createStore<'light' | 'dark'>('light');

    const storeBehaviorDef = registry.get(createStoreBehavior());
    const bindBehaviorDef = registry.get(bindStoreBehavior({ theme }));
    assert.ok(storeBehaviorDef && bindBehaviorDef);

    // Plain host Page (does NOT use storeBehavior itself)
    let pageShowCount = 0;
    let pageHideCount = 0;
    const { instance: hostPage } = createMockInstance(
      {},
      {
        getPageId: () => 'page_1',
        onShow() {
          pageShowCount += 1;
        },
        onHide() {
          pageHideCount += 1;
        },
      }
    );
    setupMockPageStack([hostPage]);

    // Mount 25 child components (mix of storeBehavior & bindStoreBehavior)
    const children: Array<{
      instance: MockPageInstance;
      payloads: Record<string, unknown>[];
      kind: 'store' | 'bind';
    }> = [];

    for (let i = 0; i < 25; i++) {
      if (i % 2 === 0) {
        const compDef: Record<string, any> = {
          properties: { idx: Number },
          store: { count },
        };
        storeBehaviorDef.definitionFilter?.(compDef);
        const child = createMockInstance(
          {},
          { getPageId: () => 'page_1', ...compDef.methods }
        );
        storeBehaviorDef.lifetimes.created?.call(child.instance);
        storeBehaviorDef.lifetimes.attached.call(child.instance);
        child.payloads.length = 0;
        children.push({ ...child, kind: 'store' });
      } else {
        const child = createMockInstance({}, { getPageId: () => 'page_1' });
        bindBehaviorDef.lifetimes.created?.call(child.instance);
        bindBehaviorDef.lifetimes.attached.call(child.instance);
        child.payloads.length = 0;
        children.push({ ...child, kind: 'bind' });
      }
    }

    // Verify hostPage.onShow / onHide were hooked ONLY once (not 25 wrapped layers)
    const hookedOnShow = hostPage.onShow;
    const hookedOnHide = hostPage.onHide;

    // Hide page -> all 25 components pause (0 setData calls during background mutations)
    hostPage.onHide?.();
    assert.equal(pageHideCount, 1);

    count.value = 1;
    count.value = 2;
    theme.value = 'dark';
    await Promise.resolve();

    for (const child of children) {
      assert.equal(child.payloads.length, 0);
    }

    // Show page -> all 25 components resume & flush ONLY latest coalesced state
    hostPage.onShow?.();
    assert.equal(pageShowCount, 1);
    assert.equal(hostPage.onShow, hookedOnShow);
    assert.equal(hostPage.onHide, hookedOnHide);

    for (const child of children) {
      assert.equal(child.payloads.length, 1);
      if (child.kind === 'store') {
        assert.deepEqual(child.payloads[0], { count: 2 });
      } else {
        assert.deepEqual(child.payloads[0], { theme: 'dark' });
      }
    }

    // Clean up all children
    for (const child of children) {
      if (child.kind === 'store') {
        storeBehaviorDef.lifetimes.detached.call(child.instance);
      } else {
        bindBehaviorDef.lifetimes.detached.call(child.instance);
      }
    }
  });

  it('handles rapid child detach and mounting on an already-hidden page cleanly', async () => {
    const registry = setupMockBehaviorRegistry();
    const count = createStore(0);
    const bindDef = registry.get(bindStoreBehavior({ count }));
    assert.ok(bindDef);

    const { instance: hostPage } = createMockInstance(
      {},
      { getPageId: () => 'page_rapid' }
    );
    setupMockPageStack([hostPage]);

    // Mount 5 children, rapidly detach 3 before onHide
    const children = Array.from({ length: 5 }, () => {
      const c = createMockInstance({}, { getPageId: () => 'page_rapid' });
      bindDef.lifetimes.attached.call(c.instance);
      c.payloads.length = 0;
      return c;
    });

    const hookedOnHide = hostPage.onHide;

    bindDef.lifetimes.detached.call(children[0]!.instance);
    bindDef.lifetimes.detached.call(children[1]!.instance);
    bindDef.lifetimes.detached.call(children[2]!.instance);

    // Hide page
    hostPage.onHide?.();

    // Detach child 3 while hidden
    bindDef.lifetimes.detached.call(children[3]!.instance);

    // Mount a brand-new child 5 while hostPage is ALREADY hidden -> must start paused
    const lateChild = createMockInstance({}, { getPageId: () => 'page_rapid' });
    bindDef.lifetimes.attached.call(lateChild.instance);
    lateChild.payloads.length = 0;
    // Must not re-patch hostPage
    assert.equal(hostPage.onHide, hookedOnHide);

    count.value = 42;
    await Promise.resolve();

    // All children (detached + paused survivor + late-mounted child) emit 0 setData
    for (const c of children) assert.equal(c.payloads.length, 0);
    assert.equal(lateChild.payloads.length, 0);

    // Resume page -> only surviving child 4 and lateChild receive { count: 42 }
    hostPage.onShow?.();
    assert.equal(children[0]!.payloads.length, 0);
    assert.equal(children[1]!.payloads.length, 0);
    assert.equal(children[2]!.payloads.length, 0);
    assert.equal(children[3]!.payloads.length, 0);
    assert.deepEqual(children[4]!.payloads, [{ count: 42 }]);
    assert.deepEqual(lateChild.payloads, [{ count: 42 }]);

    // Page unload defensively disposes any remaining handles even if child detached() was skipped
    hostPage.onUnload?.();
    children[4]!.payloads.length = 0;
    lateChild.payloads.length = 0;

    count.value = 99;
    await Promise.resolve();
    assert.equal(children[4]!.payloads.length, 0);
    assert.equal(lateChild.payloads.length, 0);
  });

  it('isolates multi-page stacks (Page A hidden while Page B active) using pageId & __wxWebviewId__', async () => {
    const registry = setupMockBehaviorRegistry();
    const count = createStore(0);
    const storeBehaviorId = createStoreBehavior();
    const storeDef = registry.get(storeBehaviorId);
    const bindDef = registry.get(bindStoreBehavior({ count }));
    assert.ok(storeDef && bindDef);

    // Page A uses storeBehavior itself AND hosts a child component
    const pageADef: Record<string, any> = {
      behaviors: [storeBehaviorId],
      store: { count },
    };
    storeDef.definitionFilter?.(pageADef);

    const pageAMock = createMockInstance(
      {},
      {
        getPageId: () => 'page_A',
        __wxWebviewId__: 101,
        store: pageADef.store,
        __codeStoreConfig__: pageADef.__codeStoreConfig__,
        __codeStorePageHooked__: pageADef.__codeStorePageHooked__,
        onLoad: pageADef.onLoad,
        onShow: pageADef.onShow,
        onHide: pageADef.onHide,
        onUnload: pageADef.onUnload,
      }
    );

    const pageStack: MockPageInstance[] = [pageAMock.instance];
    setupMockPageStack(pageStack);

    // Mount Page A + Child A (matching via getPageId)
    pageAMock.instance.onLoad?.({});
    const childA = createMockInstance({}, { getPageId: () => 'page_A' });
    bindDef.lifetimes.attached.call(childA.instance);
    pageAMock.payloads.length = 0;
    childA.payloads.length = 0;

    // Navigate to Page B: Page A hides, Page B pushes onto stack
    pageAMock.instance.onHide?.();

    const pageBMock = createMockInstance(
      {},
      { __wxWebviewId__: 202 }
    );
    pageStack.push(pageBMock.instance);

    // Mount Child B on Page B (matching via __wxWebviewId__)
    const childB = createMockInstance({}, { __wxWebviewId__: 202 });
    bindDef.lifetimes.attached.call(childB.instance);
    childB.payloads.length = 0;

    // Mutate count while Page B is active and Page A is hidden
    count.value = 10;
    count.value = 15;
    await Promise.resolve();

    // Only Child B receives setData; Page A & Child A remain paused
    assert.deepEqual(childB.payloads, [{ count: 15 }]);
    assert.equal(pageAMock.payloads.length, 0);
    assert.equal(childA.payloads.length, 0);

    // Navigate back from Page B -> Page B unloads & pops, Page A shows
    pageBMock.instance.onUnload?.();
    pageStack.pop();
    pageAMock.instance.onShow?.();

    // Page A & Child A resume and immediately flush latest value { count: 15 }
    assert.deepEqual(pageAMock.payloads, [{ count: 15 }]);
    assert.deepEqual(childA.payloads, [{ count: 15 }]);

    // Child B was disposed on Page B unload
    childB.payloads.length = 0;
    count.value = 20;
    await Promise.resolve();
    assert.equal(childB.payloads.length, 0);
    assert.deepEqual(pageAMock.payloads[1], { count: 20 });
    assert.deepEqual(childA.payloads[1], { count: 20 });

    pageAMock.instance.onUnload?.();
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
