import { storeBehavior } from 'code-store';
import {
  PRODUCTS,
  cartQtyMapStore,
  lastOrderIdStore,
  incrementProduct,
  decrementProduct,
} from '../../stores/cart';

Page({
  behaviors: [storeBehavior],

  store: {
    qtyMap: cartQtyMapStore,
    lastOrderId: lastOrderIdStore,
    incrementProduct,
    decrementProduct,
  },

  data: {
    products: PRODUCTS,
  },

  handleIncrement(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string | undefined;
    if (id) this.store.incrementProduct(id);
  },

  handleDecrement(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string | undefined;
    if (id) this.store.decrementProduct(id);
  },

  handleDismissOrder() {
    this.store.lastOrderId.value = null;
  },
});
