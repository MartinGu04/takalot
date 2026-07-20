// Application data-mode resolution.
//
// Nexus runs in one of two modes:
//   - 'supabase': real authentication and the hosted database. This is the
//     only acceptable production mode.
//   - 'demo': the local, fictional-data repository. Allowed ONLY as an
//     explicit development/test fallback -- it must never activate silently
//     in a production build.
//
// Anything else (partial configuration, an invalid URL, a key that looks
// like a server-side secret) resolves to 'misconfigured', which the app
// surfaces as a hard configuration-error screen instead of guessing.
//
// Environment contract (fixed -- these exact names, no aliases and no
// fallback between differently named variables):
//   VITE_SUPABASE_URL
//   VITE_SUPABASE_PUBLISHABLE_KEY
//   VITE_DEMO_MODE (explicit dev/test fallback only)

export type AppMode =
  | { kind: 'supabase'; url: string; publishableKey: string }
  | { kind: 'demo' }
  | { kind: 'misconfigured'; reason: string };

/**
 * True when the string looks like a Supabase service-role key or any other
 * server-side secret. The publishable (public) key is the ONLY key allowed
 * in client code; a service-role key here would grant every visitor full
 * database access.
 */
function looksLikeServerSecret(key: string): boolean {
  // New-style Supabase secret API keys.
  if (key.startsWith('sb_secret_')) return true;
  // Legacy JWT-style keys: decode the payload (no verification needed --
  // this is a self-check against accidental misconfiguration, not security
  // validation) and refuse role=service_role.
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload && payload.role === 'service_role') return true;
    } catch {
      // Not decodable as a JWT payload -- fall through; the shape check
      // below decides validity.
    }
  }
  return false;
}

/** Accepts both key formats Supabase issues for browser use: the new-style
 *  sb_publishable_… key and the legacy JWT-shaped public (anon) key. */
function looksLikePublishableKey(key: string): boolean {
  if (key.startsWith('sb_publishable_')) return true;
  const parts = key.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function resolve(env: ImportMetaEnv): AppMode {
  const url = env.VITE_SUPABASE_URL?.trim();
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  const explicitDemo = env.VITE_DEMO_MODE === 'true';

  if (explicitDemo) {
    // Explicit demo always wins -- it is how development and the e2e suite
    // opt in, and an intentional flag beats ambient credentials.
    return { kind: 'demo' };
  }

  if (url || publishableKey) {
    if (!url || !publishableKey) {
      return {
        kind: 'misconfigured',
        reason:
          'הוגדר רק אחד משני משתני הסביבה VITE_SUPABASE_URL ו־VITE_SUPABASE_PUBLISHABLE_KEY. יש להגדיר את שניהם.',
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { kind: 'misconfigured', reason: 'VITE_SUPABASE_URL אינו כתובת URL תקינה.' };
    }
    if (parsed.protocol !== 'https:') {
      return { kind: 'misconfigured', reason: 'VITE_SUPABASE_URL חייב להיות כתובת https.' };
    }
    if (looksLikeServerSecret(publishableKey)) {
      return {
        kind: 'misconfigured',
        reason:
          'המפתח שהוגדר ב־VITE_SUPABASE_PUBLISHABLE_KEY הוא מפתח שרת (service role). אסור בהחלט להשתמש בו בצד הלקוח — יש להחליפו מיידית במפתח הציבורי (publishable), ולבטל את המפתח שנחשף.',
      };
    }
    if (!looksLikePublishableKey(publishableKey)) {
      return { kind: 'misconfigured', reason: 'VITE_SUPABASE_PUBLISHABLE_KEY אינו נראה כמפתח ציבורי תקין.' };
    }
    return { kind: 'supabase', url, publishableKey };
  }

  // No configuration at all. In a production build this is a hard error --
  // never a silent demo fallback. In development / tests it falls back to
  // demo, which is the explicitly permitted development fallback.
  if (env.PROD) {
    return {
      kind: 'misconfigured',
      reason:
        'חסרה הגדרת Supabase לסביבת ייצור: יש להגדיר את VITE_SUPABASE_URL ואת VITE_SUPABASE_PUBLISHABLE_KEY בעת הבנייה.',
    };
  }
  return { kind: 'demo' };
}

let cached: AppMode | null = null;

export function getAppMode(): AppMode {
  if (!cached) cached = resolve(import.meta.env);
  return cached;
}

/** Test seam: re-resolve from a provided env (unit tests only). */
export function resolveAppModeForTest(env: Partial<ImportMetaEnv>): AppMode {
  return resolve(env as ImportMetaEnv);
}

/** Test seam: drop the cached resolution (unit tests only). */
export function resetAppModeForTest(): void {
  cached = null;
}
