import { storeBehavior } from '@code-id-labs/store';
import {
  cartCountStore,
  formattedTotalStore,
  vipAppliedStore,
} from '../../stores/cart';

Component({
  behaviors: [storeBehavior],

  store: {
    cartCount: cartCountStore,
    formattedTotal: formattedTotalStore,
    isVip: vipAppliedStore,
  },

  methods: {
    handleGoCheckout() {
      if (this.store.cartCount.peek() === 0) return;
      wx.navigateTo({ url: '/pages/checkout/index' });
    },
  },
});
