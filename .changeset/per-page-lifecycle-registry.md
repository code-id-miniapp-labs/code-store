---
"@code-id-labs/store": patch
---

Remove per-component `pageLifetimes` from `storeBehavior` and `bindStoreBehavior` to prevent WeChat MiniProgram / TCMPP `onBeforeUnloadPage_<webviewId>` listener leak warnings when mounting 20+ store-connected components on a page. Component handles are now registered in a `WeakMap`-backed per-page registry and fanned out once per page via `onShow` / `onHide` / `onUnload`.
