import '@testing-library/jest-dom/vitest';

// jsdom does not implement matchMedia; the app uses it for system dark-mode
// detection (src/lib/theme.ts) and the reduced-motion/dark listeners.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as unknown as MediaQueryList;
}

// jsdom does not implement ResizeObserver; recharts' ResponsiveContainer
// (IncidentTrendChart) needs one to learn its container's size before it
// will render its internal SVG at all -- without this, the chart silently
// renders nothing in tests, which is not the real behavior in a browser.
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom has no layout engine, so every element reports a 0x0
// getBoundingClientRect -- ResponsiveContainer treats that as "not ready"
// and never renders its chart children at all. A fixed, generous stand-in
// size lets recharts actually mount its SVG in tests instead of silently
// rendering nothing.
if (!(Element.prototype.getBoundingClientRect as { __mocked?: boolean }).__mocked) {
  const mockRect = () =>
    ({
      width: 800, height: 400, top: 0, left: 0, right: 800, bottom: 400, x: 0, y: 0, toJSON: () => {},
    }) as DOMRect;
  mockRect.__mocked = true;
  Element.prototype.getBoundingClientRect = mockRect;
}
