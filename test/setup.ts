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
