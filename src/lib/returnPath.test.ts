import { describe, expect, it } from 'vitest';
import { sanitizeInternalReturnPath } from './returnPath';

const ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

describe('sanitizeInternalReturnPath', () => {
  it('accepts a plain incident path', () => {
    expect(sanitizeInternalReturnPath(`/incidents/${ID}`)).toBe(`/incidents/${ID}`);
  });

  it('accepts an incident path with a query string', () => {
    expect(sanitizeInternalReturnPath(`/incidents/${ID}?tab=timeline`)).toBe(`/incidents/${ID}?tab=timeline`);
  });

  it('accepts an incident path with a hash', () => {
    expect(sanitizeInternalReturnPath(`/incidents/${ID}#comments`)).toBe(`/incidents/${ID}#comments`);
  });

  it('accepts an incident path with both query and hash', () => {
    expect(sanitizeInternalReturnPath(`/incidents/${ID}?tab=timeline#comments`)).toBe(
      `/incidents/${ID}?tab=timeline#comments`,
    );
  });

  it('accepts an uppercase-hex incident id (still valid uuid text)', () => {
    const upper = ID.toUpperCase();
    expect(sanitizeInternalReturnPath(`/incidents/${upper}`)).toBe(`/incidents/${upper}`);
  });

  it('rejects null/undefined/empty', () => {
    expect(sanitizeInternalReturnPath(null)).toBeNull();
    expect(sanitizeInternalReturnPath(undefined)).toBeNull();
    expect(sanitizeInternalReturnPath('')).toBeNull();
  });

  it('rejects an absolute https URL', () => {
    expect(sanitizeInternalReturnPath(`https://evil.example/incidents/${ID}`)).toBeNull();
  });

  it('rejects an absolute http URL', () => {
    expect(sanitizeInternalReturnPath(`http://evil.example/incidents/${ID}`)).toBeNull();
  });

  it('rejects a protocol-relative URL', () => {
    expect(sanitizeInternalReturnPath(`//evil.example/incidents/${ID}`)).toBeNull();
  });

  it('rejects a backslash-prefixed value the URL parser resolves as an authority (open-redirect trick)', () => {
    expect(sanitizeInternalReturnPath('/\\evil.example')).toBeNull();
    expect(sanitizeInternalReturnPath('/\\\\evil.example')).toBeNull();
  });

  it('rejects a javascript: URL', () => {
    expect(sanitizeInternalReturnPath('javascript:alert(1)')).toBeNull();
  });

  it('rejects a data: URL', () => {
    expect(sanitizeInternalReturnPath('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects a path missing the required leading slash', () => {
    expect(sanitizeInternalReturnPath(`incidents/${ID}`)).toBeNull();
  });

  it('rejects the incidents root with no id', () => {
    expect(sanitizeInternalReturnPath('/incidents')).toBeNull();
    expect(sanitizeInternalReturnPath('/incidents/')).toBeNull();
  });

  it('rejects a malformed / non-uuid incident id', () => {
    expect(sanitizeInternalReturnPath('/incidents/not-a-uuid')).toBeNull();
    expect(sanitizeInternalReturnPath('/incidents/12345')).toBeNull();
    expect(sanitizeInternalReturnPath(`/incidents/${ID}/extra`)).toBeNull();
  });

  it('rejects an unrelated internal-looking path (out of scope for this phase)', () => {
    expect(sanitizeInternalReturnPath('/admin')).toBeNull();
    expect(sanitizeInternalReturnPath('/')).toBeNull();
  });

  it('rejects an encoded/constructed external-redirect attempt', () => {
    expect(sanitizeInternalReturnPath(`/%2F%2Fevil.example/incidents/${ID}`)).toBeNull();
    expect(sanitizeInternalReturnPath(`/.evil.example/incidents/${ID}`)).toBeNull();
    expect(sanitizeInternalReturnPath(`/incidents/${ID}@evil.example`)).toBeNull();
  });
});
