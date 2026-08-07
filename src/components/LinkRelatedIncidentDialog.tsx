// קישור תקלה קשורה -- אחמ״ש ומעלה only. A narrow, bounded search (never the
// full archive dumped into a picker): requires a meaningful query, excludes
// the current incident, and the server itself caps results at 10 rows.
// Deliberately reaches closed/cancelled incidents too -- unlike the
// creation-time suggestion block, manual linking may intentionally target one.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { repo, useAppMutation } from '../data/hooks';
import { useSession } from '../auth/AuthContext';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { Dialog, Field, Input } from './ui';
import { SeverityBadge, StatusBadge } from './incident';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 400;

export function LinkRelatedIncidentDialog({
  open,
  onClose,
  incidentId,
  existingRelatedIds,
}: {
  open: boolean;
  onClose: () => void;
  incidentId: string;
  existingRelatedIds: string[];
}) {
  const [rawQuery, setRawQuery] = useState('');
  const debouncedQuery = useDebouncedValue(rawQuery, DEBOUNCE_MS);
  const session = useSession();

  const trimmed = debouncedQuery.trim();
  const { data: results, isFetching } = useQuery({
    queryKey: ['relation-search', incidentId, trimmed],
    queryFn: () => repo().searchIncidentsForRelation(session, trimmed, incidentId),
    enabled: open && trimmed.length >= MIN_QUERY_LENGTH,
  });

  const linkMutation = useAppMutation(
    (relatedIncidentId: string) => repo().manageIncidentRelation(session, incidentId, relatedIncidentId, 'link'),
    { successText: 'הקישור נוסף.', onSuccess: () => onClose() },
  );

  const handleClose = () => {
    setRawQuery('');
    onClose();
  };

  const visibleResults = (results ?? []).filter((r) => !existingRelatedIds.includes(r.id));

  return (
    <Dialog open={open} onClose={handleClose} title="קישור תקלה קשורה">
      <Field label="חיפוש לפי מספר תקלה או תיאור">
        {(a) => (
          <Input
            {...a}
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            placeholder="לדוגמה: 2026-014"
          />
        )}
      </Field>
      <div className="mt-3 flex flex-col gap-1.5">
        {trimmed.length < MIN_QUERY_LENGTH && (
          <p className="py-2 text-center text-sm text-muted">יש להזין לפחות שני תווים לחיפוש.</p>
        )}
        {trimmed.length >= MIN_QUERY_LENGTH && !isFetching && visibleResults.length === 0 && (
          <p className="py-2 text-center text-sm text-muted">לא נמצאו תקלות תואמות.</p>
        )}
        {visibleResults.map((r) => (
          <button
            key={r.id}
            type="button"
            disabled={linkMutation.isPending}
            onClick={() => linkMutation.mutate(r.id)}
            className="rounded-lg border border-hairline p-2.5 text-start transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold text-brand-700 dark:text-brand-400">{r.number}</span>
              <SeverityBadge severity={r.severity} />
              <StatusBadge status={r.status} />
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-secondary" dir="auto">
              {r.description}
            </p>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
