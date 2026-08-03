// Shared category-grouping for systems/locations. Every place that groups
// either list by category (management page sections, the grouped incident-
// creation selectors, filter bars) uses these so the fixed category order
// can never drift between call sites -- see SYSTEM_CATEGORY_ORDER /
// LOCATION_CATEGORY_ORDER in labels.ts for the actual fixed order.
import type { LocationCategory, SystemCategory } from './types';
import { LOCATION_CATEGORY_ORDER, SYSTEM_CATEGORY_ORDER } from './labels';

export interface CategoryGroup<TCategory extends string, TRecord> {
  category: TCategory;
  records: TRecord[];
}

/**
 * Always returns one entry per fixed category, in fixed order -- including
 * categories with zero matching records. Callers that must hide an empty
 * category (a native <optgroup> with no <option> children already renders
 * as nothing) can simply not special-case it; callers that must show a
 * compact empty state (the management page) can render one when
 * `records.length === 0`.
 */
export function groupSystemsByCategory<T extends { category: SystemCategory }>(
  records: T[],
): CategoryGroup<SystemCategory, T>[] {
  return SYSTEM_CATEGORY_ORDER.map((category) => ({
    category,
    records: records.filter((record) => record.category === category),
  }));
}

export function groupLocationsByCategory<T extends { category: LocationCategory }>(
  records: T[],
): CategoryGroup<LocationCategory, T>[] {
  return LOCATION_CATEGORY_ORDER.map((category) => ({
    category,
    records: records.filter((record) => record.category === category),
  }));
}
