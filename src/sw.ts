/// <reference lib="webworker" />
// AVARIA's hand-authored Service Worker (vite-plugin-pwa `injectManifest`
// strategy, since v1.5.0 Phase 3 -- see vite.config.ts for why generateSW
// was replaced). `injectManifest` only injects the build's precache
// manifest into `self.__WB_MANIFEST` below; every other behavior the
// previous generateSW build produced automatically is reproduced here by
// hand, deliberately matching it exactly (verified against the prior
// generateSW build's own output -- see the Phase 3 report).
//
// Phase 3 adds the push/notificationclick listeners so a later phase can
// start sending. Nothing in this file creates a browser PushSubscription,
// requests Notification permission, reads a VAPID key, or sends anything --
// there is no live sender yet.
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { sanitizeInternalReturnPath } from './lib/returnPath';
import { parsePushPayload } from './pwa/pushPayload';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    // Identical to the previous generateSW config's navigateFallbackDenylist
    // (vite.config.ts). This app has no same-origin API routes (Supabase is
    // a separate origin, untouched by this SW either way) -- kept as
    // defense in depth against ever serving the app-shell fallback instead
    // of a real network response for one of these paths.
    denylist: [/^\/api\//, /^\/rest\//, /^\/auth\//, /^\/storage\//, /^\/functions\//],
  }),
);

// ---------------------------------------------------------------------
// Update contract: AVARIA's existing prompt-based update flow
// (src/pwa/usePwaUpdate.ts / UpdatePrompt.tsx) calls updateServiceWorker(true),
// which -- via workbox-window's Workbox.messageSkipWaiting(), entirely
// unchanged by this migration -- posts exactly { type: 'SKIP_WAITING' } to
// the waiting worker. Under generateSW this listener was injected
// automatically by Workbox; under injectManifest it is NOT automatic and
// must be written here, or the existing "עדכון עכשיו" button would silently
// stop doing anything. No unconditional/automatic skipWaiting anywhere in
// this file -- it fires ONLY in direct response to this exact message.
// ---------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------
// push: shows a system notification from a small, deliberately minimal JSON
// payload (title/body/incidentId -- see parsePushPayload for the exact
// validation/fallback rules). No VAPID/subscription logic belongs here --
// this only reacts to a push EVENT the browser already decided to deliver.
// A malformed/unparseable payload never crashes this handler: `raw` simply
// stays null and parsePushPayload's own fallbacks apply.
// ---------------------------------------------------------------------
self.addEventListener('push', (event) => {
  let raw: unknown = null;
  try {
    raw = event.data ? event.data.json() : null;
  } catch {
    raw = null;
  }
  const { title, body, path } = parsePushPayload(raw);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // A stable, already-validated per-incident value -- collapses a
      // duplicate/retried send for the same incident into one visible
      // notification instead of stacking. No tag at all (browser default:
      // always show a new one) for the generic no-deep-link case.
      tag: path ?? undefined,
      data: { path },
    }),
  );
});

// ---------------------------------------------------------------------
// notificationclick: navigates to the validated internal path ONLY -- never
// a raw URL from the push payload. `data.path` was already produced by
// sanitizeInternalReturnPath when the push arrived (see parsePushPayload);
// it is re-validated here again before use, matching this codebase's
// existing write-side/read-side double-validation convention for return
// paths (src/lib/returnPath.ts, src/pages/LoginPage.tsx, src/App.tsx) --
// a value is never trusted merely because this same Service Worker wrote it
// earlier. Reuses an already-open AVARIA window when one exists rather than
// always opening a new one; falls back to '/' when there is no valid
// incident to route to.
// ---------------------------------------------------------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawPath = (event.notification.data as { path?: unknown } | undefined)?.path;
  const validatedPath = typeof rawPath === 'string' ? sanitizeInternalReturnPath(rawPath) : null;
  const targetUrl = new URL(validatedPath ?? '/', self.location.origin).href;

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windowClients[0];
      if (existing) {
        await existing.focus();
        if (existing.url !== targetUrl) await existing.navigate(targetUrl);
        return;
      }
      await self.clients.openWindow(targetUrl);
    })(),
  );
});
