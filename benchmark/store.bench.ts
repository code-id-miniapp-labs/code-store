import { bench, describe } from 'vitest';
import { observable, action, reaction } from 'mobx-miniprogram';
import { createStoreBindings } from 'mobx-miniprogram-bindings';
import {
  createStore,
  batch,
  bindStore,
  type SetDataCapableInstance,
} from '../packages/core/dist/index.mjs';

function createMockPage() {
  let setDataCalls = 0;
  let lastPayloadBytes = 0;

  const page: SetDataCapableInstance & { data: Record<string, unknown> } = {
    data: {},
    setData(patch: Record<string, unknown>) {
      setDataCalls += 1;
      lastPayloadBytes = JSON.stringify(patch).length;
      Object.assign(this.data, patch);
    },
  };

  return {
    page,
    get calls() {
      return setDataCalls;
    },
    get lastBytes() {
      return lastPayloadBytes;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Cold-Start Store Creation (50 state fields + 10 derived values)
// ---------------------------------------------------------------------------
describe('1. Cold-Start Store Creation (50 fields + 10 derived)', () => {
  bench('code-store (atomic createStore)', () => {
    const stores = Array.from({ length: 50 }, (_, i) => createStore(i));
    const derived = Array.from({ length: 10 }, (_, i) =>
      createStore(() => stores[i]!.value + stores[i + 10]!.value)
    );
    void derived[0]!.value;
  });

  bench('mobx-miniprogram (observable)', () => {
    const raw: Record<string, any> = {};
    for (let i = 0; i < 50; i++) {
      raw[`f${i}`] = i;
    }
    for (let i = 0; i < 10; i++) {
      Object.defineProperty(raw, `d${i}`, {
        enumerable: true,
        configurable: true,
        get() {
          return this[`f${i}`] + this[`f${i + 10}`];
        },
      });
    }
    const store = observable(raw);
    void store.d0;
  });
});

// ---------------------------------------------------------------------------
// 2. Single Primitive Update + Synchronous/Microtask setData Flush
// ---------------------------------------------------------------------------
describe('2. Single Primitive Update -> setData (20 bound fields)', () => {
  // Setup code-store
  const csAtoms = Array.from({ length: 20 }, (_, i) => createStore(i));
  const csBindings: Record<string, any> = {};
  for (let i = 0; i < 20; i++) csBindings[`f${i}`] = csAtoms[i];
  const csMock = createMockPage();
  bindStore(csMock.page, csBindings);

  // Setup mobx-miniprogram
  const mobxDef: Record<string, any> = {};
  const mobxFields: string[] = [];
  for (let i = 0; i < 20; i++) {
    mobxDef[`f${i}`] = i;
    mobxFields.push(`f${i}`);
  }
  mobxDef.inc0 = action(function (this: any) {
    this.f0 += 1;
  });
  const mobxStore = observable(mobxDef);
  const mobxMock = createMockPage();
  const mobxBinding = createStoreBindings(mobxMock.page as any, {
    store: mobxStore,
    fields: mobxFields,
    actions: ['inc0'],
  });
  mobxBinding.updateStoreBindings();

  bench('code-store (bindStore)', async () => {
    csAtoms[0]!.value += 1;
    await Promise.resolve();
  });

  bench('mobx-miniprogram (createStoreBindings)', async () => {
    mobxStore.inc0();
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// 3. Batched Multi-Field Update + Derived Recalculation (5 mutations -> 1 setData)
// ---------------------------------------------------------------------------
describe('3. Batched 5-Field Update + Derived -> setData', () => {
  const c0 = createStore(1);
  const c1 = createStore(2);
  const c2 = createStore(3);
  const c3 = createStore(4);
  const c4 = createStore(5);
  const cSum = createStore(
    () => c0.value + c1.value + c2.value + c3.value + c4.value
  );
  const csMock = createMockPage();
  bindStore(csMock.page, { c0, c1, c2, c3, c4, cSum });

  const mobxStore = observable({
    c0: 1,
    c1: 2,
    c2: 3,
    c3: 4,
    c4: 5,
    get cSum(): number {
      return this.c0 + this.c1 + this.c2 + this.c3 + this.c4;
    },
    bumpAll: action(function (this: any) {
      this.c0 += 1;
      this.c1 += 1;
      this.c2 += 1;
      this.c3 += 1;
      this.c4 += 1;
    }),
  });
  const mobxMock = createMockPage();
  const mobxBinding = createStoreBindings(mobxMock.page as any, {
    store: mobxStore,
    fields: ['c0', 'c1', 'c2', 'c3', 'c4', 'cSum'],
    actions: ['bumpAll'],
  });
  mobxBinding.updateStoreBindings();

  bench('code-store (batch)', async () => {
    batch(() => {
      c0.value += 1;
      c1.value += 1;
      c2.value += 1;
      c3.value += 1;
      c4.value += 1;
    });
    await Promise.resolve();
  });

  bench('mobx-miniprogram (action)', async () => {
    mobxStore.bumpAll();
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// 4. Nested Object Leaf Update (Profile + 10 sibling fields -> setData)
// ---------------------------------------------------------------------------
describe('4. Nested Object Leaf Mutation -> setData (diffSnapshot vs whole object)', () => {
  const initialProfile = {
    id: 'usr_98213',
    name: 'Alex Chen',
    avatar: 'https://cdn.example.com/avatars/alex-chen-hd.png',
    bio: 'WeChat MiniProgram architect & coffee enthusiast',
    tier: 'gold',
    address: {
      country: 'CN',
      city: 'Shanghai',
      district: 'Pudong',
      street: '88 Century Avenue',
      zip: '200120',
    },
    stats: {
      orders: 42,
      points: 1000,
      coupons: 5,
    },
  };

  const csProfile = createStore(initialProfile);
  const csMock = createMockPage();
  bindStore(csMock.page, { profile: csProfile });

  const mobxStore = observable({
    profile: structuredClone(initialProfile),
    addPoint: action(function (this: any) {
      this.profile = {
        ...this.profile,
        stats: { ...this.profile.stats, points: this.profile.stats.points + 1 },
      };
    }),
  });
  const mobxMock = createMockPage();
  const mobxBinding = createStoreBindings(mobxMock.page as any, {
    store: mobxStore,
    fields: ['profile'],
    actions: ['addPoint'],
  });
  mobxBinding.updateStoreBindings();

  bench('code-store (surgical diffSnapshot path)', async () => {
    const prev = csProfile.peek();
    csProfile.value = {
      ...prev,
      stats: { ...prev.stats, points: prev.stats.points + 1 },
    };
    await Promise.resolve();
  });

  bench('mobx-miniprogram (full object setData)', async () => {
    mobxStore.addPoint();
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// 5. Page Mount & Unmount Churn (Bind + Dispose Lifecycle)
// ---------------------------------------------------------------------------
describe('5. Page Lifecycle Churn (mount + dispose 10 bound fields)', () => {
  const csAtoms = Array.from({ length: 10 }, (_, i) => createStore(i));
  const csMap: Record<string, any> = {};
  for (let i = 0; i < 10; i++) csMap[`f${i}`] = csAtoms[i];

  const mobxDef: Record<string, any> = {};
  const mobxFields: string[] = [];
  for (let i = 0; i < 10; i++) {
    mobxDef[`f${i}`] = i;
    mobxFields.push(`f${i}`);
  }
  const mobxStore = observable(mobxDef);

  bench('code-store (bindStore + dispose)', () => {
    const { page } = createMockPage();
    const handle = bindStore(page, csMap);
    handle.dispose();
  });

  bench('mobx-miniprogram (createStoreBindings + destroy)', () => {
    const { page } = createMockPage();
    const b = createStoreBindings(page as any, {
      store: mobxStore,
      fields: mobxFields,
      actions: [],
    });
    b.updateStoreBindings();
    b.destroyStoreBindings();
  });
});

// ---------------------------------------------------------------------------
// 6. Multi-Component Fan-Out (10 Components listening to 1 shared atom)
// ---------------------------------------------------------------------------
describe('6. Multi-Component Fan-Out (10 components -> 1 mutation)', () => {
  const csCount = createStore(0);
  const csTotal = createStore(() => csCount.value * 2990);
  for (let i = 0; i < 10; i++) {
    const { page } = createMockPage();
    bindStore(page, { count: csCount, total: csTotal });
  }

  const mobxStore = observable({
    count: 0,
    get total(): number {
      return this.count * 2990;
    },
    inc: action(function (this: any) {
      this.count += 1;
    }),
  });
  for (let i = 0; i < 10; i++) {
    const { page } = createMockPage();
    const b = createStoreBindings(page as any, {
      store: mobxStore,
      fields: ['count', 'total'],
      actions: [],
    });
    b.updateStoreBindings();
  }

  bench('code-store (10 subscribers)', async () => {
    csCount.value += 1;
    await Promise.resolve();
  });

  bench('mobx-miniprogram (10 subscribers)', async () => {
    mobxStore.inc();
    await Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// 7. Direct Store Subscribe + Notify (store.subscribe vs MobX reaction)
// ---------------------------------------------------------------------------
describe('7. Direct Store Subscribe + Notify (subscribe vs MobX reaction)', () => {
  const csCount = createStore(0);
  let csSink = 0;
  csCount.subscribe((val) => {
    csSink = val;
  });

  const mobxStore = observable({
    count: 0,
    inc: action(function (this: any) {
      this.count += 1;
    }),
  });
  let mobxSink = 0;
  reaction(
    () => mobxStore.count,
    (val) => {
      mobxSink = val;
    }
  );

  bench('code-store (store.subscribe)', () => {
    csCount.value += 1;
    void csSink;
  });

  bench('mobx-miniprogram (reaction)', () => {
    mobxStore.inc();
    void mobxSink;
  });
});

// ---------------------------------------------------------------------------
// 8. Subscribe + Unsubscribe Churn (subscribe() + unsubscribe() vs reaction)
// ---------------------------------------------------------------------------
describe('8. Subscribe + Unsubscribe Churn', () => {
  const csCount = createStore(0);
  const mobxStore = observable({ count: 0 });

  bench('code-store (subscribe + unsubscribe)', () => {
    const unsubscribe = csCount.subscribe(() => {});
    unsubscribe();
  });

  bench('mobx-miniprogram (reaction + dispose)', () => {
    const dispose = reaction(
      () => mobxStore.count,
      () => {}
    );
    dispose();
  });
});
