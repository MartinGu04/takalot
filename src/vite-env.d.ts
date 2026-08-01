/// <reference types="vite/client" />

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
  }

  export default function bidiFactory(): Bidi;
}
