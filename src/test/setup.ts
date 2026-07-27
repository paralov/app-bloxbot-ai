import "@testing-library/jest-dom/vitest";

const testStorage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return testStorage.size;
    },
    clear: () => testStorage.clear(),
    getItem: (key: string) => testStorage.get(key) ?? null,
    key: (index: number) => [...testStorage.keys()][index] ?? null,
    removeItem: (key: string) => testStorage.delete(key),
    setItem: (key: string, value: string) => testStorage.set(key, String(value)),
  } satisfies Storage,
});

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {};

// jsdom doesn't implement matchMedia (used for system theme)
Object.defineProperty(window, "matchMedia", {
  writable: true,
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
