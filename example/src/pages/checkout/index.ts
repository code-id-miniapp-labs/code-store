import { storeBehavior } from '@code-id-labs/store';
import {
  cartItemsStore,
  cartCountStore,
  orderNoteStore,
  formattedTotalStore,
  incrementProduct,
  decrementProduct,
  setOrderNote,
  clearCart,
  placeOrder,
} from '../../stores/cart';

Page({
  behaviors: [storeBehavior],

  store: {
    cartItems: cartItemsStore,
    cartCount: cartCountStore,
    orderNote: orderNoteStore,
    formattedTotal: formattedTotalStore,
    incrementProduct,
    decrementProduct,
    setOrderNote,
    clearCart,
    placeOrder,
  },

  handleIncrement(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string | undefined;
    if (id) this.store.incrementProduct(id);
  },

  handleDecrement(e: WechatMiniprogram.BaseEvent) {
    const id = e.currentTarget.dataset.id as string | undefined;
    if (id) this.store.decrementProduct(id);
  },

  handleNoteInput(e: WechatMiniprogram.CustomEvent<{ value?: string }>) {
    const val = typeof e.detail === 'string' ? e.detail : (e.detail?.value ?? '');
    this.store.setOrderNote(val);
  },

  handleClearCart() {
    this.store.clearCart();
  },

  handlePlaceOrder() {
    if (this.store.cartCount.peek() === 0) return;
    const orderId = this.store.placeOrder();
    wx.showToast({
      title: `Paid ${orderId}`,
      icon: 'success',
    });
    setTimeout(() => {
      wx.navigateBack();
    }, 600);
  },

  handleBackToShop() {
    wx.navigateBack();
  },
});
