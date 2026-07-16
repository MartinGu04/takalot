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
