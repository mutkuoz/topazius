import { vi } from 'vitest';
import type { GitHubClient } from '../src/lib/github';

/**
 * A GitHubClient where every method is present but only the ones a test names
 * actually work. Anything else rejects loudly, so a test that reaches an
 * endpoint it did not mean to exercise fails instead of silently passing.
 */
export function stubClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  const unused = (name: string) => () => Promise.reject(new Error(`${name}() was not stubbed by this test`));
  return {
    getRepo: vi.fn(unused('getRepo')),
    getTree: vi.fn(unused('getTree')),
    getBlob: vi.fn(unused('getBlob')),
    getFile: vi.fn(unused('getFile')),
    putFile: vi.fn(unused('putFile')),
    deleteFile: vi.fn(unused('deleteFile')),
    ...overrides,
  };
}
