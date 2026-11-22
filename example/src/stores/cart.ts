import { createStore, createPersistentStore, batch } from '@code-id-labs/store';
import { useColorMode } from '@code-id-labs/composables';

export type ThemeMode = 'light' | 'dark';

export interface Product {
  id: string;
  name: string;
  subtitle: string;
  tag: string;
  priceCents: number;
  priceLabel: string;
}

export interface CartItem {
  id: string;
  name: string;
  priceCents: number;
  priceLabel: string;
  qty: number;
}

export const PRODUCTS: Product[] = [
  {
    id: 'matcha',
    name: 'Uji Matcha Latte',
    subtitle: 'Ceremonial grade with oat milk',
    tag: 'Popular',
    priceCents: 3200,
    priceLabel: '¥32.00',
  },
  {
    id: 'coldbrew',
    name: 'Nitro Cold Brew',
    subtitle: 'Slow-steeped 18h single origin',
    tag: 'Iced',
    priceCents: 2800,
    priceLabel: '¥28.00',
  },
  {
    id: 'croissant',
    name: 'Almond Croissant',
    subtitle: 'Flaky butter pastry, baked fresh',
    tag: 'Bakery',
    priceCents: 2400,
    priceLabel: '¥24.00',
  },
  {
    id: 'tonic',
    name: 'Espresso Tonic',
    subtitle: 'Double shot with yuzu tonic',
    tag: 'Signature',
    priceCents: 3500,
    priceLabel: '¥35.00',
  },
];

function formatCents(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`;
}

export const themeModeStore = createPersistentStore<ThemeMode>('demo:colorMode', 'light');
export const cartItemsStore = createPersistentStore<CartItem[]>('demo:cartItems', []);
export const vipAppliedStore = createPersistentStore<boolean>('demo:vip', false);
export const orderNoteStore = createPersistentStore<string>('demo:orderNote', '', {
  debounceMs: 300,
});

export const shippingStore = createStore({
  recipient: 'Alex Chen',
  city: 'Shanghai',
  express: false,
});
export const lastOrderIdStore = createStore<string | null>(null);


const colorMode = useColorMode({
  initialValue: themeModeStore.peek(),
});

export function toggleColorMode(): void {
  const next: ThemeMode = themeModeStore.peek() === 'light' ? 'dark' : 'light';
  themeModeStore.value = next;
  colorMode.setMode(next);
}

export const cartCountStore = createStore(() =>
  cartItemsStore.value.reduce((sum, item) => sum + item.qty, 0)
);

export const cartQtyMapStore = createStore<Record<string, number>>(() => {
  const map: Record<string, number> = {};
  for (const item of cartItemsStore.value) {
    map[item.id] = item.qty;
  }
  return map;
});

export const subtotalCentsStore = createStore(() =>
  cartItemsStore.value.reduce((sum, item) => sum + item.priceCents * item.qty, 0)
);

export const discountCentsStore = createStore(() =>
  vipAppliedStore.value ? Math.round(subtotalCentsStore.value * 0.15) : 0
);

export const shippingCentsStore = createStore(() =>
  cartCountStore.value > 0 && shippingStore.value.express ? 1200 : 0
);

export const totalCentsStore = createStore(
  () =>
    subtotalCentsStore.value -
    discountCentsStore.value +
    shippingCentsStore.value
);

export const formattedSubtotalStore = createStore(() =>
  formatCents(subtotalCentsStore.value)
);
export const formattedDiscountStore = createStore(() =>
  discountCentsStore.value > 0 ? `-${formatCents(discountCentsStore.value)}` : '¥0.00'
);
export const formattedShippingStore = createStore(() =>
  shippingCentsStore.value > 0 ? formatCents(shippingCentsStore.value) : 'Free'
);
export const formattedTotalStore = createStore(() =>
  formatCents(totalCentsStore.value)
);

// Atomic actions
export function incrementProduct(productId: string): void {
  const items = cartItemsStore.peek();
  const idx = items.findIndex((i) => i.id === productId);

  if (idx !== -1) {
    const existing = items[idx];
    if (!existing) return;
    const next = items.slice();
    next[idx] = { ...existing, qty: existing.qty + 1 };
    cartItemsStore.value = next;
    return;
  }

  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) return;
  cartItemsStore.value = [
    ...items,
    {
      id: product.id,
      name: product.name,
      priceCents: product.priceCents,
      priceLabel: product.priceLabel,
      qty: 1,
    },
  ];
}

export function decrementProduct(productId: string): void {
  const items = cartItemsStore.peek();
  const idx = items.findIndex((i) => i.id === productId);
  if (idx === -1) return;

  const existing = items[idx];
  if (!existing) return;

  if (existing.qty <= 1) {
    cartItemsStore.value = items.filter((i) => i.id !== productId);
  } else {
    const next = items.slice();
    next[idx] = { ...existing, qty: existing.qty - 1 };
    cartItemsStore.value = next;
  }
}

export function toggleVipPromo(): void {
  vipAppliedStore.value = !vipAppliedStore.peek();
}

export function toggleExpressShipping(): void {
  const prev = shippingStore.peek();
  shippingStore.value = { ...prev, express: !prev.express };
}

export function setOrderNote(note: string): void {
  orderNoteStore.value = note;
}

export function clearCart(): void {
  batch(() => {
    cartItemsStore.clear();
    vipAppliedStore.reset();
    orderNoteStore.clear();
    shippingStore.reset();
  });
}

export function placeOrder(): string {
  const orderId = `ORD-${Date.now().toString().slice(-5)}`;
  batch(() => {
    lastOrderIdStore.value = orderId;
    cartItemsStore.clear();
    orderNoteStore.clear();
    shippingStore.reset();
  });
  return orderId;
}
