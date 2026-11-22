import { storeBehavior } from '@code-id-labs/store';
import {
  cartCountStore,
  formattedSubtotalStore,
  formattedDiscountStore,
  formattedShippingStore,
  formattedTotalStore,
  vipAppliedStore,
  shippingStore,
  toggleVipPromo,
  toggleExpressShipping,
} from '../../stores/cart';

Component({
  behaviors: [storeBehavior],

  store: {
    cartCount: cartCountStore,
    formattedSubtotal: formattedSubtotalStore,
    formattedDiscount: formattedDiscountStore,
    formattedShipping: formattedShippingStore,
    formattedTotal: formattedTotalStore,
    isVip: vipAppliedStore,
    shipping: shippingStore,
    toggleVipPromo,
    toggleExpressShipping,
  },

  methods: {
    handleToggleVip() {
      this.store.toggleVipPromo();
    },

    handleToggleExpress() {
      this.store.toggleExpressShipping();
    },
  },
});
