import { describe, expect, it } from 'vitest';
import { groupLocationsByCategory, groupSystemsByCategory } from './referenceDataCategories';
import { LOCATION_CATEGORY_ORDER, SYSTEM_CATEGORY_ORDER } from './labels';
import type { LocationRecord, SystemRecord } from './types';

function system(id: string, category: SystemRecord['category']): SystemRecord {
  return { id, name: id, archived: false, category, displayOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' };
}

function location(id: string, category: LocationRecord['category']): LocationRecord {
  return { id, name: id, archived: false, category, displayOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' };
}

describe('groupSystemsByCategory', () => {
  it('always returns one group per fixed category, in the fixed order, even when empty', () => {
    const groups = groupSystemsByCategory([]);
    expect(groups.map((g) => g.category)).toEqual(SYSTEM_CATEGORY_ORDER);
    expect(groups.every((g) => g.records.length === 0)).toBe(true);
  });

  it('places each record only in its own category, preserving input order within a category', () => {
    const a = system('a', 'computing');
    const b = system('b', 'platforms');
    const c = system('c', 'computing');
    const groups = groupSystemsByCategory([a, b, c]);
    expect(groups.find((g) => g.category === 'computing')?.records).toEqual([a, c]);
    expect(groups.find((g) => g.category === 'platforms')?.records).toEqual([b]);
    expect(groups.find((g) => g.category === 'other')?.records).toEqual([]);
  });
});

describe('groupLocationsByCategory', () => {
  it('always returns one group per fixed category, in the fixed order, even when empty', () => {
    const groups = groupLocationsByCategory([]);
    expect(groups.map((g) => g.category)).toEqual(LOCATION_CATEGORY_ORDER);
  });

  it('places each record only in its own category', () => {
    const a = location('a', 'field_side');
    const b = location('b', 'unit_internal');
    const groups = groupLocationsByCategory([a, b]);
    expect(groups.find((g) => g.category === 'field_side')?.records).toEqual([a]);
    expect(groups.find((g) => g.category === 'unit_internal')?.records).toEqual([b]);
  });
});
