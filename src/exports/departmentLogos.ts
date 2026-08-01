// Loads the two approved department logos for the incident PDF header, at
// runtime, from their canonical public/ paths -- the same files and same
// paths DepartmentLogos.tsx already renders in the app header. Fetching the
// exact bytes at export time (rather than embedding a base64 copy in the
// bundle) means there is exactly one copy of each asset in the repository;
// see DepartmentLogos.tsx's own comment, which anticipated this reuse.
import { DEPARTMENT_LOGOS } from '../components/DepartmentLogos';

export interface DepartmentLogoBytes {
  key: string;
  bytes: Uint8Array;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`נכשלה טעינת לוגו המחלקה (${url}): ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Loads both approved department logos, in the same fixed order they are
 *  displayed in the app header (see DEPARTMENT_LOGOS). */
export async function loadDepartmentLogoBytes(): Promise<DepartmentLogoBytes[]> {
  return Promise.all(
    DEPARTMENT_LOGOS.map(async (logo) => ({ key: logo.key, bytes: await fetchBytes(logo.src) })),
  );
}
