import { describe, expect, it } from 'vitest';
import { Cache } from '../src/client/cache.js';

describe('cache payload budget', () => {
  it('evicts least recently used entries to satisfy bytes and entry limits', () => {
    const cache = new Cache(10000, 3, 10, 8);
    cache.set('a', 'a', undefined, 4);
    cache.set('b', 'b', undefined, 4);
    expect(cache.get('a')).toBe('a');
    cache.set('c', 'c', undefined, 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('a');
    expect(cache.accountedBytes).toBe(8);
  });
  it('skips oversized entries and updates byte accounting on replacement/invalidation', () => {
    const cache = new Cache(10000, 2, 10, 8);
    cache.set('a', 'small', undefined, 4);
    cache.set('a', 'changed', undefined, 6);
    cache.set('huge', 'huge', undefined, 9);
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.accountedBytes).toBe(6);
    const generation = cache.generation();
    cache.invalidate();
    cache.set('stale', 'stale', generation, 4);
    expect(cache.accountedBytes).toBe(0);
    expect(cache.get('stale')).toBeUndefined();
  });
});
