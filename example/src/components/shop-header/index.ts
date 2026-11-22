import { storeBehavior } from 'code-store';
import {
  cartCountStore,
  themeModeStore,
  toggleColorMode,
} from '../../stores/cart';

Component({
  behaviors: [storeBehavior],

  store: {
    cartCount: cartCountStore,
    themeMode: themeModeStore,
    toggleColorMode,
  },

  methods: {
    handleToggleTheme() {
      this.store.toggleColorMode();
    },
  },
});
