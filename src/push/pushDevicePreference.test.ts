import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPushWanted, isPushWanted, rememberPushWanted } from './pushDevicePreference';

beforeEach(() => {
  localStorage.clear();
});

describe('pushDevicePreference', () => {
  it('is false for a user who never enabled Push on this device', () => {
    expect(isPushWanted('user-a')).toBe(false);
  });

  it('remembers a user after rememberPushWanted', () => {
    rememberPushWanted('user-a');
    expect(isPushWanted('user-a')).toBe(true);
  });

  it('is scoped per user -- a different user on the same device is unaffected', () => {
    rememberPushWanted('user-a');
    expect(isPushWanted('user-b')).toBe(false);
  });

  it('clearPushWanted forgets a previously remembered user', () => {
    rememberPushWanted('user-a');
    clearPushWanted('user-a');
    expect(isPushWanted('user-a')).toBe(false);
  });

  it('clearing one user never affects another remembered user', () => {
    rememberPushWanted('user-a');
    rememberPushWanted('user-b');
    clearPushWanted('user-a');
    expect(isPushWanted('user-a')).toBe(false);
    expect(isPushWanted('user-b')).toBe(true);
  });

  it('never throws when localStorage.getItem throws (e.g. storage disabled)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(() => isPushWanted('user-a')).not.toThrow();
    expect(isPushWanted('user-a')).toBe(false);
    spy.mockRestore();
  });

  it('never throws when localStorage.setItem throws (e.g. quota exceeded)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    expect(() => rememberPushWanted('user-a')).not.toThrow();
    spy.mockRestore();
  });

  it('never throws when localStorage.removeItem throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(() => clearPushWanted('user-a')).not.toThrow();
    spy.mockRestore();
  });
});
