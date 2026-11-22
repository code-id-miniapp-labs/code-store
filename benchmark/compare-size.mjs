import { gzipSync, brotliCompressSync } from 'node:zlib';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import {
  createStore,
  bindStore,
} from '../packages/core/dist/index.mjs';

// mobx-miniprogram-bindings invokes global `Behavior()` eagerly on import
globalThis.Behavior = () => 'mock-behavior';
const { observable, action } = (await import('mobx-miniprogram')).default;
const { createStoreBindings } = (await import('mobx-miniprogram-bindings')).default;

const ROOT = resolve(import.meta.dirname, '..');

function fmtKB(bytes) {
  return `${(bytes / 1024).toFixed(2)} kB`;
}

async function measureBundle(label, code) {
  const dir = mkdtempSync(join(tmpdir(), 'code-store-size-'));
  const entry = join(dir, 'entry.mjs');
  writeFileSync(entry, code);

  try {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: 'esm',
      target: 'es2020',
      write: false,
      nodePaths: [join(ROOT, 'node_modules'), join(ROOT, 'packages/core/node_modules')],
      alias: {
        '@code-id-labs/store': join(ROOT, 'packages/core/dist/index.mjs'),
      },
      define: {
        'process.env.NODE_ENV': '"production"',
      },
    });

    const buf = Buffer.from(result.outputFiles[0].contents);
    const gz = gzipSync(buf, { level: 9 });
    const br = brotliCompressSync(buf);

    return {
      label,
      raw: buf.length,
      gzip: gz.length,
      brotli: br.length,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function measureSetDataPayloads() {
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

  const initialCart = [
    { id: 'matcha', name: 'Uji Matcha Latte', priceCents: 3200, priceLabel: '¥32.00', qty: 1 },
    { id: 'coldbrew', name: 'Nitro Cold Brew', priceCents: 2800, priceLabel: '¥28.00', qty: 2 },
    { id: 'croissant', name: 'Almond Croissant', priceCents: 2400, priceLabel: '¥24.00', qty: 1 },
    { id: 'tonic', name: 'Espresso Tonic', priceCents: 3500, priceLabel: '¥35.00', qty: 1 },
  ];

  // code-store
  const csProfile = createStore(initialProfile);
  const csCart = createStore(initialCart);
  let csLast = null;
  const csPage = {
    data: {},
    setData(p) {
      csLast = p;
      Object.assign(this.data, p);
    },
  };
  const csHandle = bindStore(csPage, { profile: csProfile, cart: csCart });

  // mobx-miniprogram
  const mobxStore = observable({
    profile: structuredClone(initialProfile),
    cart: structuredClone(initialCart),
    addPoint: action(function () {
      this.profile = {
        ...this.profile,
        stats: { ...this.profile.stats, points: this.profile.stats.points + 1 },
      };
    }),
    incCart0: action(function () {
      const next = this.cart.slice();
      next[0] = { ...next[0], qty: next[0].qty + 1 };
      this.cart = next;
    }),
  });
  let mobxLast = null;
  const mobxPage = {
    data: {},
    setData(p) {
      mobxLast = p;
      Object.assign(this.data, p);
    },
  };
  const mobxBinding = createStoreBindings(mobxPage, {
    store: mobxStore,
    fields: ['profile', 'cart'],
    actions: ['addPoint', 'incCart0'],
  });
  mobxBinding.updateStoreBindings();

  // Test 1: Nested profile leaf update
  csLast = null;
  mobxLast = null;
  const prevP = csProfile.peek();
  csProfile.value = { ...prevP, stats: { ...prevP.stats, points: prevP.stats.points + 1 } };
  mobxStore.addPoint();
  await Promise.resolve();
  mobxBinding.updateStoreBindings();

  const nestedResult = {
    scenario: 'Nested object leaf (profile.stats.points)',
    codeStoreBytes: JSON.stringify(csLast).length,
    codeStorePayload: JSON.stringify(csLast),
    mobxBytes: JSON.stringify(mobxLast).length,
  };

  // Test 2: Array item qty update
  csLast = null;
  mobxLast = null;
  const nextCart = csCart.peek().slice();
  nextCart[0] = { ...nextCart[0], qty: nextCart[0].qty + 1 };
  csCart.value = nextCart;
  mobxStore.incCart0();
  await Promise.resolve();
  mobxBinding.updateStoreBindings();

  const arrayResult = {
    scenario: 'Array item leaf (cart[0].qty)',
    codeStoreBytes: JSON.stringify(csLast).length,
    codeStorePayload: JSON.stringify(csLast),
    mobxBytes: JSON.stringify(mobxLast).length,
  };

  csHandle.dispose();
  mobxBinding.destroyStoreBindings();
  return [nestedResult, arrayResult];
}

const bundles = await Promise.all([
  measureBundle(
    'code-store (minimal: createStore + batch + bindStore)',
    `import { createStore, batch, bindStore } from '@code-id-labs/store';
     export { createStore, batch, bindStore };`
  ),
  measureBundle(
    'code-store (full: + persistentStore + storeBehavior + diffSnapshot)',
    `import { createStore, createPersistentStore, batch, bindStore, storeBehavior, bindStoreBehavior, createStoreBehavior, diffSnapshot } from '@code-id-labs/store';
     export { createStore, createPersistentStore, batch, bindStore, storeBehavior, bindStoreBehavior, createStoreBehavior, diffSnapshot };`
  ),
  measureBundle(
    'mobx-miniprogram + mobx-miniprogram-bindings',
    `import { observable, action } from 'mobx-miniprogram';
     import { createStoreBindings, storeBindingsBehavior } from 'mobx-miniprogram-bindings';
     export { observable, action, createStoreBindings, storeBindingsBehavior };`
  ),
]);

console.log('\n=== Bundle Size Comparison (Minified Production Bundle) ===');
console.table(
  bundles.map((b) => ({
    Package: b.label,
    'Minified': fmtKB(b.raw),
    'Gzip (lv9)': fmtKB(b.gzip),
    'Brotli': fmtKB(b.brotli),
  }))
);

const payloads = await measureSetDataPayloads();
console.log('\n=== setData IPC Payload Size Comparison ===');
console.table(
  payloads.map((p) => ({
    Scenario: p.scenario,
    '@code-id-labs/store': `${p.codeStoreBytes} B (${p.codeStorePayload})`,
    'mobx-miniprogram': `${p.mobxBytes} B`,
    'Reduction': `${(((p.mobxBytes - p.codeStoreBytes) / p.mobxBytes) * 100).toFixed(1)}% smaller`,
  }))
);
