import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Single build-time source of truth for the displayed app version (Sidebar /
// mobile עוד screen -- see src/config/appVersion.ts) -- read from package.json
// rather than duplicated as a literal, so a release bump only ever touches
// one file. Applies identically under `vite build` and `vitest` (this same
// config object doubles as the Vitest config below), so the constant is
// exercised by tests too, not just the production bundle.
const pkgVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }).version;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Never register a Service Worker in `vite dev` -- this repo has no
      // existing dev-mode PWA setup, so dev keeps serving straight from
      // Vite with no SW in the loop.
      devOptions: { enabled: false },
      // We call registerSW() ourselves (src/pwa/usePwaUpdate.ts) so the
      // "new version available" notice is a user choice, never a silent
      // auto-reload -- so the plugin must not inject its own registration
      // script into index.html.
      injectRegister: false,
      registerType: 'prompt',
      // injectManifest (not generateSW): a hand-authored Service Worker
      // (src/sw.ts) is required starting AVARIA v1.5.0 so it can host
      // Push/notificationclick handlers -- generateSW only ever produces a
      // precache-and-navigation-fallback worker with no room to add
      // arbitrary event listeners. `registerType`/`injectRegister` above are
      // unaffected by this switch: both are consumed by the plugin's
      // strategy-agnostic client register script (virtual:pwa-register),
      // never by the generated/injected worker file itself -- confirmed
      // against node_modules/vite-plugin-pwa/dist/client/build/register.js,
      // which branches on `registerType` before ever knowing which strategy
      // built the worker it's talking to.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        id: '/',
        name: 'AVARIA — מערכת ניהול ומעקב תקלות',
        short_name: 'AVARIA',
        description: 'AVARIA — מערכת ניהול ומעקב תקלות',
        lang: 'he',
        dir: 'rtl',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Existing app theme tokens (src/index.css / index.html) --
        // no new PWA-specific colors invented.
        theme_color: '#f1efe9',
        background_color: '#f1efe9',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icons/maskable-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // injectManifest's build-time config -- ONLY controls what is fed
      // into src/sw.ts's `self.__WB_MANIFEST` at build time, via
      // globPatterns (the identical set the previous generateSW config
      // used). navigateFallback/navigateFallbackDenylist/
      // cleanupOutdatedCaches have no equivalent option here -- unlike
      // generateSW, injectManifest does not generate that routing logic for
      // you; it is hand-authored in src/sw.ts instead (NavigationRoute +
      // cleanupOutdatedCaches(), matching this exact denylist).
      injectManifest: {
        // App shell only: the built JS/CSS/HTML and the self-hosted font
        // the shell renders with. Deliberately excludes public/branding
        // marketing art and the favicon/apple-touch-icon set -- those are
        // OS/tab chrome, not "required to load the interface", and skipping
        // them keeps the precache small.
        // 'fonts/Heebo-Regular.ttf' is listed explicitly rather than by a
        // broad **/*.ttf pattern: public/fonts also ships the two Alef
        // weights, but those are only ever read as inlined base64 by the PDF
        // export (src/exports/pdf.ts) -- never fetched by the running page --
        // so a broad ttf glob would precache build assets nothing actually
        // requests.
        globPatterns: ['**/*.{js,css,html}', 'fonts/Heebo-Regular.ttf'],
      },
    }),
  ],
  server: { port: 5173 },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
  },
});
