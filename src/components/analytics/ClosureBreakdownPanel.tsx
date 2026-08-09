// "סיווג סגירות" -- what actually causes incidents (confirmed, settled
// cause, not the provisional current-suspected-cause) and what happens
// after we treat them (permanent fix vs. band-aid). Both breakdowns come
// from the exact same immutable incident_closures cohort, scoped to the
// selected period.
//
// The coverage footer is the load-bearing correctness note here: incident
// closures only exist for FULL-readiness closures, so "closures with
// structured data" is a strict subset of "closure actions this period" --
// see analyticsClosureInsights.ts's header for the full X <= Y reasoning
// (sourced from the immutable incident_events log, not incidents.closedAt).
// Always shown as visible text, never hidden behind an info tooltip -- too
// load-bearing for an optional affordance.
import { confirmedCauseLabels, treatmentOutcomeLabels } from '../../domain/labels';
import type { AnalyticsEnumCount, IncidentClosureInsights } from '../../domain/analyticsClosureInsights';
import type { ConfirmedCause, TreatmentOutcome } from '../../domain/types';
import { EmptyState } from '../ui';

function EnumBreakdownList<T extends string>({
  title,
  entries,
  labels,
  total,
}: {
  title: string;
  entries: AnalyticsEnumCount<T>[];
  labels: Record<T, string>;
  total: number;
}) {
  return (
    <div>
      <h3 className="text-sm font-bold text-text-primary">{title}</h3>
      <div className="surface mt-2 divide-y divide-hairline overflow-hidden">
        {entries.map((entry) => (
          <div key={entry.value} className="flex items-center gap-3 px-3 py-2.5">
            {/* No truncate: the cause/outcome label IS this row's primary
                content, not a secondary/attribution detail -- matches the
                codebase's own wrap-don't-truncate convention for identifying
                fields (see RankingList/IncidentCard). */}
            <span className="min-w-0 flex-1 text-sm font-medium text-text-primary">{labels[entry.value]}</span>
            <span className="shrink-0 text-sm font-semibold text-text-primary">{entry.count}</span>
            <span className="w-10 shrink-0 text-end text-xs text-muted">
              {total > 0 ? Math.round((entry.count / total) * 100) : 0}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ClosureBreakdownPanel({
  insights,
  causeOrOutcomeFilterActive = false,
}: {
  insights: IncidentClosureInsights;
  /** Whether a confirmed-cause/treatment-outcome filter is currently
   *  active. When it is, structuredClosuresInPeriod (the numerator below)
   *  only counts closures matching that filter, while
   *  totalClosureEventsInPeriod (the denominator) still counts every
   *  closure action in the period regardless of cause/outcome -- see
   *  analyticsClosureInsights.ts's header. The footer below adds one
   *  clarifying sentence in that case so "X out of Y" is never misread as
   *  both numbers describing the same closure-filtered population. */
  causeOrOutcomeFilterActive?: boolean;
}) {
  if (insights.totalClosureEventsInPeriod === 0) {
    return <EmptyState compact title="אין תקלות עם פעולת סגירה בתקופה שנבחרה" />;
  }
  if (insights.structuredClosuresInPeriod === 0) {
    return (
      <EmptyState
        compact
        title="אין תקלות עם סיווג סגירה מובנה בתקופה זו"
        subtitle="התקלות שנסגרו בתקופה זו נסגרו ללא סיווג מובנה (סגירה עם כשירות חלקית, או סגירה ללא סיווג)."
      />
    );
  }
  return (
    <div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <EnumBreakdownList<ConfirmedCause>
          title="גורם שאומת"
          entries={insights.confirmedCauseCounts}
          labels={confirmedCauseLabels}
          total={insights.structuredClosuresInPeriod}
        />
        <EnumBreakdownList<TreatmentOutcome>
          title="תוצאת הטיפול"
          entries={insights.treatmentOutcomeCounts}
          labels={treatmentOutcomeLabels}
          total={insights.structuredClosuresInPeriod}
        />
      </div>
      <p className="mt-4 text-xs leading-relaxed text-muted">
        מבוסס על {insights.structuredClosuresInPeriod} מתוך {insights.totalClosureEventsInPeriod} תקלות עם פעולת
        סגירה בתקופה זו (סגירות מלאות עם סיווג מובנה בלבד).
        {causeOrOutcomeFilterActive && (
          <>
            {' '}
            המספר הראשון תואם את סינון הגורם/התוצאה שנבחר; המספר השני כולל את כלל פעולות הסגירה בתקופה, גם כאלה
            שאינן תואמות את הסינון.
          </>
        )}
      </p>
    </div>
  );
}
