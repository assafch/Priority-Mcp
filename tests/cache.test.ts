import { describe, it, expect, vi } from 'vitest';
import { Cache } from '../src/client/cache.js';

describe('Cache', () => {
  it('returns undefined for missing keys', () => {
    const cache = new Cache(1000);
    expect(cache.get('nope')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    const cache = new Cache(1000);
    cache.set('key', { data: 42 });
    expect(cache.get('key')).toEqual({ data: 42 });
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    const cache = new Cache(100);
    cache.set('key', 'value');
    expect(cache.get('key')).toBe('value');

    vi.advanceTimersByTime(150);
    expect(cache.get('key')).toBeUndefined();
    vi.useRealTimers();
  });

  it('evicts oldest when max entries reached', () => {
    const cache = new Cache(10000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3); // should evict 'a'
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('invalidates by pattern', () => {
    const cache = new Cache(10000);
    cache.set('CUSTOMERS?a', 1);
    cache.set('CUSTOMERS?b', 2);
    cache.set('ORDERS?c', 3);
    cache.invalidate('CUSTOMERS');
    expect(cache.get('CUSTOMERS?a')).toBeUndefined();
    expect(cache.get('CUSTOMERS?b')).toBeUndefined();
    expect(cache.get('ORDERS?c')).toBe(3);
  });

  it('invalidates all when no pattern', () => {
    const cache = new Cache(10000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.invalidate();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });
});
