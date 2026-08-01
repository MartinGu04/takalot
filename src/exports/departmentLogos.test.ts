import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDepartmentLogoBytes } from './departmentLogos';
import { DEPARTMENT_LOGOS } from '../components/DepartmentLogos';

describe('loadDepartmentLogoBytes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches both logos from their exact canonical public paths and returns their unmodified bytes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const logo = DEPARTMENT_LOGOS.find((l) => l.src === url);
      if (!logo) throw new Error(`unexpected fetch: ${url}`);
      const bytes = readFileSync(`public${logo.src}`);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await loadDepartmentLogoBytes();

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.key).sort()).toEqual(DEPARTMENT_LOGOS.map((l) => l.key).sort());
    for (const logo of DEPARTMENT_LOGOS) {
      const onDisk = new Uint8Array(readFileSync(`public${logo.src}`));
      const loaded = result.find((r) => r.key === logo.key)!.bytes;
      expect(loaded).toEqual(onDisk);
    }
  });

  it('throws a Hebrew error message when a logo fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    await expect(loadDepartmentLogoBytes()).rejects.toThrow(/לוגו/);
  });
});
