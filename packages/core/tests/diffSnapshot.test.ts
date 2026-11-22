import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshot } from '../dist/index.mjs';

describe('diffSnapshot', () => {
  it('handles primitives in O(1), skips identical values, and maps undefined -> null', () => {
    const out: Record<string, unknown> = {};
    assert.equal(diffSnapshot(1, 1, 'count', out), false);
    assert.deepEqual(out, {});

    assert.equal(diffSnapshot(1, 2, 'count', out), true);
    assert.deepEqual(out, { count: 2 });

    const out2: Record<string, unknown> = {};
    assert.equal(diffSnapshot(NaN, NaN, 'score', out2), false);
    assert.deepEqual(out2, {});

    // Undefined transitions become null so WeChat WXML clears stale UI
    const out3: Record<string, unknown> = {};
    assert.equal(diffSnapshot('hello', undefined, 'label', out3), true);
    assert.deepEqual(out3, { label: null });
  });

  it('emits minimal dot-paths for nested plain object mutations', () => {
    const sharedAddress = { city: 'Shanghai', zip: '200000' };
    const prev = {
      name: 'Alice',
      stats: { likes: 10, followers: 20 },
      address: sharedAddress,
    };
    const next = {
      name: 'Alice',
      stats: { likes: 11, followers: 20 },
      address: sharedAddress,
    };

    const out: Record<string, unknown> = {};
    assert.equal(diffSnapshot(prev, next, 'user', out), true);
    assert.deepEqual(out, { 'user.stats.likes': 11 });
  });

  it('returns false when two distinct object references are structurally identical', () => {
    const out: Record<string, unknown> = {};
    assert.equal(
      diffSnapshot(
        { a: 1, nested: { b: 'ok' } },
        { a: 1, nested: { b: 'ok' } },
        'obj',
        out
      ),
      false
    );
    assert.deepEqual(out, {});
  });

  it('falls back to replacing parent object (stripping undefined) when a key is deleted', () => {
    const prev = { a: 1, b: 2 };
    const next = { a: 1, c: undefined };
    const out: Record<string, unknown> = {};

    assert.equal(diffSnapshot(prev, next, 'user', out), true);
    assert.deepEqual(out, { user: { a: 1 } });
  });

  it('emits bracket-paths for array item mutations and appends', () => {
    const item2 = { id: 2, qty: 3 };
    const prev = [{ id: 1, qty: 1 }, item2];
    const next = [{ id: 1, qty: 2 }, item2, { id: 3, qty: 1 }];
    const out: Record<string, unknown> = {};

    assert.equal(diffSnapshot(prev, next, 'items', out), true);
    assert.deepEqual(out, {
      'items[0].qty': 2,
      'items[2]': { id: 3, qty: 1 },
    });
  });

  it('replaces entire array when array shrinks and sanitizes undefined elements', () => {
    const prev = [{ id: 1 }, { id: 2 }];
    const next = [undefined];
    const out: Record<string, unknown> = {};

    assert.equal(diffSnapshot(prev, next, 'items', out), true);
    assert.deepEqual(out, { items: [null] });
  });

  it('replaces parent when changed key contains WeChat path delimiters', () => {
    const prev = { 'a.b': 1, ok: true };
    const next = { 'a.b': 2, ok: true };
    const out: Record<string, unknown> = {};

    assert.equal(diffSnapshot(prev, next, 'map', out), true);
    assert.deepEqual(out, { map: { 'a.b': 2, ok: true } });
  });
});
