// Pure, environment-agnostic validation for the small JSON payload a Push
// message carries -- no DOM or Service Worker globals referenced, so this
// is importable from both the Service Worker (src/sw.ts) and its Vitest
// suite under jsdom.
//
// A push payload is external input: nothing proves it came from AVARIA's
// own (not-yet-existing, Phase 5) Edge Function, so this must never throw
// and must never surface anything beyond the approved minimal, non-
// operational lock-screen copy -- no incident description, system,
// location, personnel names, external-party details, or operational-impact
// text ever belongs in a push payload, so none of that is read here even if
// present.
import { sanitizeInternalReturnPath } from '../lib/returnPath';

export interface ParsedPushNotification {
  title: string;
  body: string;
  /** Already-validated, safe internal path (see sanitizeInternalReturnPath),
   *  or null when no valid incident id was supplied -- the notification is
   *  then a plain AVARIA notice with no deep link. */
  path: string | null;
}

const FALLBACK_TITLE = 'AVARIA';
const FALLBACK_BODY = 'יש עדכון חדש ב-AVARIA.';
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 500;

function safeText(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return fallback;
  return trimmed;
}

/**
 * Parses a Push message's JSON payload into exactly what the Service Worker
 * needs to show a notification. Never throws, regardless of input shape.
 * A missing/malformed/unusable payload degrades to a minimal generic AVARIA
 * notice with no deep link (title/body fall back, path is null) rather than
 * being dropped silently -- a broken payload stays visible/debuggable
 * instead of vanishing, and the fallback copy carries no sensitive content
 * either way.
 */
export function parsePushPayload(raw: unknown): ParsedPushNotification {
  const data = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const incidentId = typeof data.incidentId === 'string' ? data.incidentId : null;
  // Delegates the actual shape/safety check to the same helper Phase 1's
  // OAuth return-path flow uses -- one validated definition of "a safe
  // internal AVARIA path", not a second hand-rolled UUID check here.
  const path = incidentId ? sanitizeInternalReturnPath(`/incidents/${incidentId}`) : null;
  return {
    title: safeText(data.title, MAX_TITLE_LENGTH, FALLBACK_TITLE),
    body: safeText(data.body, MAX_BODY_LENGTH, FALLBACK_BODY),
    path,
  };
}
