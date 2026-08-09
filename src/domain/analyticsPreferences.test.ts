import { describe, expect, it } from 'vitest';
import { ANALYTICS_MODULE_KEYS, normalizeAnalyticsModules } from './analyticsPreferences';

describe('normalizeAnalyticsModules', () => {
  it('passes null through unchanged (no stored preference at all)', () => {
    expect(normalizeAnalyticsModules(null)).toBeNull();
  });

  it('leaves a fully-valid stored preference unchanged, including order', () => {
    expect(normalizeAnalyticsModules(['closures', 'trend'])).toEqual(['closures', 'trend']);
  });

  it('regression: drops a legacy module key no longer supported (e.g. the removed externalInvolvement) while preserving every valid key around it', () => {
    // Exactly the shape an existing hosted-DB row could still contain after
    // 'externalInvolvement' was removed from AnalyticsModuleKey/
    // ANALYTICS_MODULE_KEYS -- the array itself is untyped at the DB
    // boundary, so a stale value like this can genuinely arrive here.
    const legacyStored = ['trend', 'closures', 'externalInvolvement'];
    expect(normalizeAnalyticsModules(legacyStored)).toEqual(['trend', 'closures']);
  });

  it('never discards the whole preference just because ONE entry is unrecognized', () => {
    const result = normalizeAnalyticsModules(['ageDistribution', 'externalInvolvement', 'topLocations']);
    expect(result).toEqual(['ageDistribution', 'topLocations']);
  });

  it('normalizes a preference made up entirely of unrecognized keys to an empty (not null) array -- a real "nothing valid is enabled" state, not "no preference stored"', () => {
    expect(normalizeAnalyticsModules(['externalInvolvement', 'someOtherRetiredModule'])).toEqual([]);
  });

  it('every currently supported key survives normalization untouched', () => {
    expect(normalizeAnalyticsModules([...ANALYTICS_MODULE_KEYS])).toEqual(ANALYTICS_MODULE_KEYS);
  });
});
