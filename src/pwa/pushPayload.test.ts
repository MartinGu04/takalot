import { describe, expect, it } from 'vitest';
import { parsePushPayload } from './pushPayload';

const ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('parsePushPayload', () => {
  it('accepts a valid full payload', () => {
    expect(parsePushPayload({ title: 'AVARIA', body: 'תקלה שויכה אליך', incidentId: ID })).toEqual({
      title: 'AVARIA',
      body: 'תקלה שויכה אליך',
      path: `/incidents/${ID}`,
    });
  });

  it('falls back to the generic title/body and null path for null', () => {
    expect(parsePushPayload(null)).toEqual({
      title: 'AVARIA',
      body: 'יש עדכון חדש ב-AVARIA.',
      path: null,
    });
  });

  it('falls back for undefined', () => {
    expect(parsePushPayload(undefined).path).toBeNull();
  });

  it('falls back for a non-object payload (string)', () => {
    expect(parsePushPayload('not an object')).toEqual({
      title: 'AVARIA',
      body: 'יש עדכון חדש ב-AVARIA.',
      path: null,
    });
  });

  it('falls back for a non-object payload (number)', () => {
    expect(parsePushPayload(42).path).toBeNull();
  });

  it('falls back for a non-object payload (array)', () => {
    expect(parsePushPayload([1, 2, 3]).path).toBeNull();
  });

  it('omits incidentId cleanly -- valid title/body, null path', () => {
    expect(parsePushPayload({ title: 'AVARIA', body: 'נפתחה תקלה חדשה' })).toEqual({
      title: 'AVARIA',
      body: 'נפתחה תקלה חדשה',
      path: null,
    });
  });

  it('rejects a malformed (non-uuid) incidentId -- path stays null', () => {
    expect(parsePushPayload({ title: 'AVARIA', body: 'x', incidentId: 'not-a-uuid' }).path).toBeNull();
  });

  it('rejects an incidentId carrying an external-redirect attempt', () => {
    expect(parsePushPayload({ incidentId: '../../evil.example' }).path).toBeNull();
    expect(parsePushPayload({ incidentId: `${ID}@evil.example` }).path).toBeNull();
    expect(parsePushPayload({ incidentId: 'https://evil.example' }).path).toBeNull();
  });

  it('falls back when title is missing, empty, or not a string', () => {
    expect(parsePushPayload({ body: 'x' }).title).toBe('AVARIA');
    expect(parsePushPayload({ title: '', body: 'x' }).title).toBe('AVARIA');
    expect(parsePushPayload({ title: '   ', body: 'x' }).title).toBe('AVARIA');
    expect(parsePushPayload({ title: 42, body: 'x' }).title).toBe('AVARIA');
    expect(parsePushPayload({ title: { evil: true }, body: 'x' }).title).toBe('AVARIA');
  });

  it('falls back when body is missing, empty, or not a string', () => {
    expect(parsePushPayload({ title: 'x' }).body).toBe('יש עדכון חדש ב-AVARIA.');
    expect(parsePushPayload({ title: 'x', body: '' }).body).toBe('יש עדכון חדש ב-AVARIA.');
    expect(parsePushPayload({ title: 'x', body: 42 }).body).toBe('יש עדכון חדש ב-AVARIA.');
  });

  it('falls back to title when it exceeds the length limit', () => {
    const tooLong = 'א'.repeat(201);
    expect(parsePushPayload({ title: tooLong, body: 'x' }).title).toBe('AVARIA');
  });

  it('falls back to body when it exceeds the length limit', () => {
    const tooLong = 'א'.repeat(501);
    expect(parsePushPayload({ title: 'x', body: tooLong }).body).toBe('יש עדכון חדש ב-AVARIA.');
  });

  it('trims valid title/body', () => {
    expect(parsePushPayload({ title: '  AVARIA  ', body: '  תקלה  ' })).toEqual({
      title: 'AVARIA',
      body: 'תקלה',
      path: null,
    });
  });

  it('ignores any extra/operational fields present on the payload (defense in depth)', () => {
    const result = parsePushPayload({
      title: 'AVARIA',
      body: 'תקלה שויכה אליך',
      incidentId: ID,
      description: 'תיאור תפעולי רגיש',
      location: 'מיקום רגיש',
      system: 'מערכת רגישה',
    });
    expect(result).toEqual({ title: 'AVARIA', body: 'תקלה שויכה אליך', path: `/incidents/${ID}` });
  });

  it('never throws for any input shape', () => {
    const inputs: unknown[] = [null, undefined, '', 0, false, [], {}, { incidentId: 123 }, Symbol('x'), () => {}];
    for (const input of inputs) {
      expect(() => parsePushPayload(input)).not.toThrow();
    }
  });
});
