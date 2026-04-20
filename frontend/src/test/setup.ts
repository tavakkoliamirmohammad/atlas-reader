import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Node 25 ships an experimental built-in `localStorage` that lacks a usable
// `setItem`/`getItem`/`clear` (it needs `--localstorage-file`). That stub
// shadows the jsdom Storage implementation, so we install a tiny in-memory
// polyfill on `window` and the global before any test code runs.
function makeStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store = new Map();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };
}

Object.defineProperty(globalThis, "localStorage", {
  value: makeStorage(),
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: makeStorage(),
  configurable: true,
  writable: true,
});
if (typeof window !== "undefined") {
  Object.defineProperty(window, "localStorage", {
    value: globalThis.localStorage,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(window, "sessionStorage", {
    value: globalThis.sessionStorage,
    configurable: true,
    writable: true,
  });
}

afterEach(() => cleanup());
