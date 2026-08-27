import 'fake-indexeddb/auto';
import { webcrypto } from 'node:crypto';

// happy-dom does not supply a WebCrypto implementation. Node's is spec-compliant
// and is what crypto.ts exercises, so install it when it is missing.
if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

/**
 * CodeMirror measures text by asking a Range for its client rectangles. jsdom
 * has no layout, so `Range.prototype.getClientRects` is missing entirely and
 * CM6's measure pass - which runs from requestAnimationFrame, outside any
 * test's await - throws an unhandled TypeError that fails the whole run.
 *
 * Stubbing it with zero-sized rectangles is enough: nothing here asserts on
 * geometry, and an editor that believes every line is zero pixels tall still
 * dispatches transactions, runs commands, and reports its document correctly.
 */
if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  const empty = Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getClientRects = () => empty;
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}

import '@testing-library/jest-dom/vitest';
