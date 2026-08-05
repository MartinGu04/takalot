import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
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
      workbox: {
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
        navigateFallback: '/index.html',
        // Defense in depth: this app has no same-origin API routes (Supabase
        // is a separate origin, untouched by this SW either way), but keep
        // any local /api-shaped path from ever being served the app-shell
        // fallback instead of a real network response.
        navigateFallbackDenylist: [/^\/api\//, /^\/rest\//, /^\/auth\//, /^\/storage\//, /^\/functions\//],
        cleanupOutdatedCaches: true,
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
