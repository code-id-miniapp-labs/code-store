import assert from 'node:assert/strict';
import { createStore, bindStore } from '../packages/core/dist/index.mjs';

if (typeof globalThis.gc !== 'function') {
  console.error('Run with: node --expose-gc benchmark/memory.mjs');
  process.exit(1);
}

const gc = globalThis.gc;

function forceGC() {
  gc();
  gc();
}

function measureHeap(label, fn) {
  forceGC();
  const before = process.memoryUsage().heapUsed;
  const keep = fn();
  forceGC();
  const after = process.memoryUsage().heapUsed;
  const deltaKB = (after - before) / 1024;
  return { label, deltaKB, keep };
}

async function runRetentionAssertions() {
  // 1. Retained `unsubscribe` handle must NOT pin prevValue, listener closure, or store.
  let prevValRef;
  let listenerStateRef;
  let storeRef;
  const retainedUnsub = (() => {
    const bigPrev = { tag: 'prev', payload: new Uint8Array(1024 * 64) };
    const bigClosure = { tag: 'closure', payload: new Uint8Array(1024 * 64) };
    const s = createStore(bigPrev);
    prevValRef = new WeakRef(bigPrev);
    listenerStateRef = new WeakRef(bigClosure);
    storeRef = new WeakRef(s);

    const unsub = s.subscribe(() => {
      void bigClosure.payload.byteLength;
    });
    s.value = { tag: 'next', payload: new Uint8Array(4) };
    unsub();
    return unsub;
  })();

  await new Promise((r) => setTimeout(r, 10));
  forceGC();
  assert.equal(
    prevValRef.deref() === undefined,
    true,
    'unsubscribed handle must not retain previous value'
  );
  assert.equal(
    listenerStateRef.deref() === undefined,
    true,
    'unsubscribed handle must not retain listener closure'
  );
  assert.equal(
    storeRef.deref() === undefined,
    true,
    'unsubscribed handle must not retain store'
  );
  void retainedUnsub;

  // 2. Derived store must release cached `_prevVal` and listener closure once all subscribers leave.
  const base = createStore(1);
  let derivedPrevRef;
  let derivedClosureRef;
  const derived = createStore(() => ({
    n: base.value,
    payload: new Uint8Array(1024 * 64),
  }));
  const retainedDerivedUnsub = (() => {
    const closureObj = { payload: new Uint8Array(1024 * 64) };
    derivedClosureRef = new WeakRef(closureObj);
    const unsub = derived.subscribe(() => {
      void closureObj.payload.byteLength;
    });
    derivedPrevRef = new WeakRef(derived.peek());
    base.value = 2;
    unsub();
    return unsub;
  })();

  await new Promise((r) => setTimeout(r, 10));
  forceGC();
  assert.equal(
    derivedPrevRef.deref() === undefined,
    true,
    'unsubscribed derived store must not retain old snapshot'
  );
  assert.equal(
    derivedClosureRef.deref() === undefined,
    true,
    'unsubscribed derived handle must not retain listener closure'
  );
  void [retainedDerivedUnsub, derived];

  // 3. bindStore must NOT retain `initialPatch` snapshot after mount update, nor `pending` after flush,
  //    nor `instance` after `dispose()` even while `handle` is still held.
  let initialObjRef;
  let flushedObjRef;
  let pageRef;
  const profile = createStore(null);
  const retainedHandle = await (async () => {
    const page = {
      data: {},
      setData() {},
    };
    pageRef = new WeakRef(page);

    const mountSnapshot = { buf: new Uint8Array(1024 * 64) };
    profile.value = mountSnapshot;
    initialObjRef = new WeakRef(mountSnapshot);
    const handle = bindStore(page, { profile });

    const mid = { buf: new Uint8Array(1024 * 64) };
    flushedObjRef = new WeakRef(mid);
    profile.value = mid;
    await Promise.resolve();

    profile.value = { buf: new Uint8Array(4) };
    await Promise.resolve();

    return handle;
  })();

  await new Promise((r) => setTimeout(r, 10));
  forceGC();
  assert.equal(
    initialObjRef.deref() === undefined,
    true,
    'mounted bindStore must not retain initialPatch snapshot'
  );
  assert.equal(
    flushedObjRef.deref() === undefined,
    true,
    'flushed bindStore must not retain previous pending snapshot'
  );

  retainedHandle.dispose();
  await new Promise((r) => setTimeout(r, 10));
  forceGC();
  assert.equal(
    pageRef.deref() === undefined,
    true,
    'disposed StoreBindingHandle must not retain Page/Component instance'
  );
  void retainedHandle;
}

const r1 = measureHeap('5,000 idle createStore(i)', () =>
  Array.from({ length: 5000 }, (_, i) => createStore(i))
);
const r2 = measureHeap('5,000 stores x 1 subscribe each', () =>
  r1.keep.map((s) => s.subscribe(() => {}))
);
const r3 = measureHeap('1 store x 5,000 subscribers (fan-out)', () => {
  const atom = createStore(0);
  return {
    atom,
    unsubs: Array.from({ length: 5000 }, () => atom.subscribe(() => {})),
  };
});
const d1 = createStore(() => r1.keep[0].value * 2);
const r4 = measureHeap('1 derived x 5,000 subscribers (fan-out)', () =>
  Array.from({ length: 5000 }, () => d1.subscribe(() => {}))
);
const r5 = measureHeap('500 components x 5 bound stores (bindStore)', () => {
  const atoms = Array.from({ length: 5 }, (_, i) => createStore(i));
  const bindings = {
    a: atoms[0],
    b: atoms[1],
    c: atoms[2],
    d: atoms[3],
    e: atoms[4],
  };
  return Array.from({ length: 500 }, () =>
    bindStore({ data: {}, setData() {} }, bindings)
  );
});

const rows = [r1, r2, r3, r4, r5];
console.log('\n=== Heap Memory Footprint (V8, --expose-gc) ===');
console.table(
  rows.map((r) => ({
    Scenario: r.label,
    'Retained Heap': `${r.deltaKB.toFixed(1)} KB`,
  }))
);

void [r1, r2, r3, r4, r5, d1];

await runRetentionAssertions();
console.log('✔ All WeakRef GC retention assertions passed.');
