// mobx-miniprogram-bindings invokes WeChat's global `Behavior()` eagerly at module import time.
(globalThis as unknown as { Behavior: (def: unknown) => string }).Behavior = () => 'mock-behavior';
