import type { SetDataCapableInstance, StoreBindingHandle } from './types';

export const PAGE_HOOKED_KEY = '__codeStorePageHooked__';

export interface PageLike extends SetDataCapableInstance {
  getPageId?: () => string;
  __wxWebviewId__?: number;
  onShow?: (...args: any[]) => any;
  onHide?: (...args: any[]) => any;
  onUnload?: (...args: any[]) => any;
  [PAGE_HOOKED_KEY]?: boolean;
}

interface PageRegistryEntry {
  handles: Set<StoreBindingHandle>;
  hidden: boolean;
}

const pageRegistry = new WeakMap<object, PageRegistryEntry>();
const patchedPages = new WeakSet<object>();

function getOrCreateEntry(page: PageLike): PageRegistryEntry {
  let entry = pageRegistry.get(page);
  if (!entry) {
    entry = { handles: new Set(), hidden: false };
    pageRegistry.set(page, entry);
  }
  return entry;
}

/** Resolves the owning Page instance for a Page or Component via `getCurrentPages()`. */
export function resolveHostPage(instance: PageLike): PageLike | undefined {
  if (typeof getCurrentPages !== 'function') {
    return undefined;
  }
  const pages = getCurrentPages() as unknown as PageLike[] | undefined;
  if (!pages || pages.length === 0) {
    return undefined;
  }

  for (let i = pages.length - 1; i >= 0; i--) {
    if (pages[i] === instance) {
      return instance;
    }
  }

  const pageId =
    typeof instance.getPageId === 'function' ? instance.getPageId() : undefined;
  if (pageId !== undefined && pageId !== '') {
    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i];
      if (p && typeof p.getPageId === 'function' && p.getPageId() === pageId) {
        return p;
      }
    }
  }

  const webviewId = instance.__wxWebviewId__;
  if (webviewId !== undefined) {
    for (let i = pages.length - 1; i >= 0; i--) {
      const p = pages[i];
      if (p && p.__wxWebviewId__ === webviewId) {
        return p;
      }
    }
  }

  return pages[pages.length - 1];
}

export function notifyPageShow(page: PageLike): void {
  const entry = getOrCreateEntry(page);
  entry.hidden = false;
  entry.handles.forEach((handle) => {
    handle.resume();
  });
}

export function notifyPageHide(page: PageLike): void {
  const entry = getOrCreateEntry(page);
  entry.hidden = true;
  entry.handles.forEach((handle) => {
    handle.pause();
  });
}

export function notifyPageUnload(page: PageLike): void {
  const entry = pageRegistry.get(page);
  if (!entry) {
    return;
  }
  entry.handles.forEach((handle) => {
    handle.dispose();
  });
  entry.handles.clear();
  pageRegistry.delete(page);
}

/** Idempotently hooks `onShow`, `onHide`, and `onUnload` once per Page instance. */
export function ensurePageLifecycleHook(page: PageLike): void {
  if (patchedPages.has(page) || page[PAGE_HOOKED_KEY]) {
    return;
  }
  patchedPages.add(page);

  const origOnShow = page.onShow;
  const origOnHide = page.onHide;
  const origOnUnload = page.onUnload;

  page.onShow = function (this: PageLike, ...args: unknown[]) {
    notifyPageShow(this);
    if (origOnShow) {
      return origOnShow.apply(this, args);
    }
  };

  page.onHide = function (this: PageLike, ...args: unknown[]) {
    notifyPageHide(this);
    if (origOnHide) {
      return origOnHide.apply(this, args);
    }
  };

  page.onUnload = function (this: PageLike, ...args: unknown[]) {
    try {
      if (origOnUnload) {
        return origOnUnload.apply(this, args);
      }
    } finally {
      notifyPageUnload(this);
    }
  };
}

export function registerPageHandle(
  instance: PageLike,
  handle: StoreBindingHandle
): PageLike | undefined {
  const hostPage = resolveHostPage(instance);
  if (!hostPage) {
    return undefined;
  }
  ensurePageLifecycleHook(hostPage);
  const entry = getOrCreateEntry(hostPage);
  entry.handles.add(handle);
  if (entry.hidden) {
    handle.pause();
  }
  return hostPage;
}

export function unregisterPageHandle(
  hostPage: PageLike | undefined,
  handle: StoreBindingHandle
): void {
  if (!hostPage) {
    return;
  }
  pageRegistry.get(hostPage)?.handles.delete(handle);
}
