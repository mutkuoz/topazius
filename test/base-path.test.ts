import { describe, expect, it } from 'vitest';
import { resolveBase } from '../scripts/base-path';

describe('resolveBase', () => {
  it('defaults to root for local development', () => {
    expect(resolveBase({})).toBe('/');
  });

  it('wraps a bare repository name in slashes', () => {
    expect(resolveBase({ PAGES_BASE: 'topazius' })).toBe('/topazius/');
  });

  it('normalises a value that already has slashes', () => {
    expect(resolveBase({ PAGES_BASE: '/topazius/' })).toBe('/topazius/');
  });

  it('treats blank and whitespace-only values as root', () => {
    expect(resolveBase({ PAGES_BASE: '' })).toBe('/');
    expect(resolveBase({ PAGES_BASE: '   ' })).toBe('/');
    expect(resolveBase({ PAGES_BASE: '/' })).toBe('/');
  });
});
