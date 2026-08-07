// נמצאו תקלות פעילות שעשויות להיות קשורות -- inline, non-blocking suggestion
// block shown during incident creation. A recommender, never a decision
// maker: it never blocks submission, never labels anything a duplicate, and
// creates no relationship by itself -- only an explicit "קשר לתקלה זו"
// selection (reported back to the caller, actually linked only after a
// successful creation) does that. See domain/similarity.ts for the
// selection algorithm and IncidentCreatePage for how selections become
// real links.
import { Link } from 'react-router-dom';
import { useSimilarIncidentSuggestions, useLocations, useSystems } from '../data/hooks';
import { formatSuggestionReason } from '../domain/similarity';
import { SeverityBadge, StatusBadge } from './incident';
import { IconLightbulb } from './icons';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import type { IncidentDomain, SimilarIncidentSuggestion } from '../domain/types';

/** Trigger conditions: system selected AND description past a meaningful
 *  minimum length. Location/domain are optional enrichment -- the query
 *  fires without them if that's genuinely all that's filled in yet. */
const MIN_DESCRIPTION_LENGTH = 15;
/** Longer than the 300ms used for the plain list-search box: this fires a
 *  server round-trip mid-sentence, not a client-side list filter. */
const DEBOUNCE_MS = 500;

function actionButtonClass(active: boolean): string {
  return active
    ? 'inline-flex min-h-8 items-center gap-1 rounded-md border border-brand-400 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-800 dark:border-brand-700 dark:bg-brand-950/50 dark:text-brand-200'
    : 'inline-flex min-h-8 items-center gap-1 rounded-md border border-hairline-strong px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-hover';
}

export function SimilarIncidentSuggestions({
  systemId,
  locationId,
  reportedDomain,
  description,
  selectedIds,
  dismissedIds,
  onToggleSelect,
  onDismiss,
}: {
  systemId: string;
  locationId: string;
  reportedDomain: IncidentDomain | '';
  description: string;
  selectedIds: Set<string>;
  dismissedIds: Set<string>;
  onToggleSelect: (suggestion: SimilarIncidentSuggestion) => void;
  onDismiss: (incidentId: string) => void;
}) {
  const debounced = useDebouncedValue({ systemId, locationId, reportedDomain, description }, DEBOUNCE_MS);
  const trigger = Boolean(debounced.systemId) && debounced.description.trim().length >= MIN_DESCRIPTION_LENGTH;
  const { data: suggestions, isError } = useSimilarIncidentSuggestions(
    {
      systemId: debounced.systemId,
      locationId: debounced.locationId || null,
      reportedDomain: debounced.reportedDomain || null,
      description: debounced.description,
    },
    trigger,
  );
  const { data: systems } = useSystems();
  const { data: locations } = useLocations();

  // Silent on failure -- an optional recommendation, never a reason to
  // alarm the user filling out an incident report. Silent while loading
  // too (no spinner): appearing a moment after typing stops reads as
  // natural, not as something broken while it's pending.
  if (isError || !suggestions) return null;
  const visible = suggestions.filter((s) => !dismissedIds.has(s.incidentId));
  if (visible.length === 0) return null;

  const systemName = (id: string) => systems?.find((s) => s.id === id)?.name ?? '—';
  const locationName = (id: string) => locations?.find((l) => l.id === id)?.name ?? '—';

  return (
    // Amber/yellow -- "worth a look", never red/error. The panel only
    // exists in the DOM while a match is visible, so the entrance-glow
    // class plays once on mount and never restarts on ordinary rerenders
    // (see the CSS comment in index.css for why).
    <div className="suggestion-panel-entrance rounded-xl border border-amber-300 bg-amber-50 p-3 shadow-soft dark:border-amber-800/70 dark:bg-amber-950/30">
      <div className="flex items-center gap-1.5">
        <IconLightbulb className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
          נמצאו תקלות פעילות שעשויות להיות קשורות
        </p>
      </div>
      <ul className="mt-2 flex flex-col gap-2">
        {visible.map((s) => {
          const selected = selectedIds.has(s.incidentId);
          return (
            <li key={s.incidentId} className="rounded-lg border border-hairline bg-canvas p-2.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-bold text-brand-700 dark:text-brand-400">{s.number}</span>
                <SeverityBadge severity={s.severity} />
                <StatusBadge status={s.status} />
              </div>
              <p className="mt-0.5 text-xs text-secondary">
                {systemName(s.systemId)} · {locationName(s.locationId)}
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-text-secondary" dir="auto">
                {s.description}
              </p>
              <p className="mt-1 text-xs text-muted">{formatSuggestionReason(s)}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link
                  to={`/incidents/${s.incidentId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-8 items-center rounded-md border border-hairline-strong px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-hover"
                >
                  צפה בתקלה
                  <span className="sr-only"> (נפתח בכרטיסייה חדשה)</span>
                </Link>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onToggleSelect(s)}
                  className={actionButtonClass(selected)}
                >
                  {selected ? '✓ יקושר עם השמירה' : 'קשר לתקלה זו'}
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(s.incidentId)}
                  className="inline-flex min-h-8 items-center rounded-md px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-hover"
                >
                  התעלם
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
