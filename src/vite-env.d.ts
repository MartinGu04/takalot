/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** 'true' enables the local demo repository. Development/tests only —
   *  production builds without Supabase config fail loudly instead. */
  readonly VITE_DEMO_MODE?: string;
  /** Web Push application-server public key (VAPID), base64url-encoded.
   *  Optional in v1.5.0 Phase 4 -- the real hosted keypair is a Phase 5
   *  operational step. Absent/invalid resolves to the client's
   *  'configuration-unavailable' Push state rather than a crash; see
   *  src/push/vapidKey.ts. Never the PRIVATE key -- that must never exist
   *  in a VITE_* variable, which ships to every browser. */
  readonly VITE_VAPID_PUBLIC_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected at build time (vite.config.ts `define`) from package.json's
 *  `version` field -- the single source of truth for src/config/appVersion.ts.
 *  Never a secret, environment detail, branch name, or commit SHA. */
declare const __APP_VERSION__: string;

// bidi-js ships no type declarations. Minimal surface for the functions
// src/exports/bidi.ts actually uses -- see that file for how/why.
declare module 'bidi-js' {
  export interface EmbeddingLevelsResult {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }

  export interface Bidi {
    getEmbeddingLevels(text: string, baseDirection?: 'rtl' | 'ltr'): EmbeddingLevelsResult;
    getReorderedString(text: string, embeddingLevels: EmbeddingLevelsResult, start?: number, end?: number): string;
    getMirroredCharacter(char: string): string | null;
  }

  export default function bidiFactory(): Bidi;
}
