/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  /** 'true' enables the local demo repository. Development/tests only —
   *  production builds without Supabase config fail loudly instead. */
  readonly VITE_DEMO_MODE?: string;
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
