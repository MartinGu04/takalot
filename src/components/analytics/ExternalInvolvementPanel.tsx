// "מעורבות גורם חיצוני" -- three genuinely separate concepts, never merged
// into one number (see analyticsClosureInsights.ts / analyticsSummary.ts):
//   1. causeExternalClosedCount -- period-scoped, closure-time CAUSE fact
//      (confirmedCause = 'external').
//   2. resolutionAttributionExternalCount -- period-scoped, closure-time
//      TREATMENT attribution fact (resolutionAttribution =
//      'external_party_no_details'). A different question from #1: what
//      caused it vs. who gets credit for resolving it.
//   3. externallyHandledOpenCount -- CURRENT-STATE, not period-bound
//      (currently-open incidents with an external handler recorded) --
//      visually set apart below since it doesn't share the other two's
//      period scope.
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-2xl font-extrabold leading-none text-text-primary">{value}</span>
      <span className="text-xs leading-relaxed text-muted">{label}</span>
    </div>
  );
}

export function ExternalInvolvementPanel({
  causeExternalClosedCount,
  resolutionAttributionExternalCount,
  externallyHandledOpenCount,
}: {
  causeExternalClosedCount: number;
  resolutionAttributionExternalCount: number;
  externallyHandledOpenCount: number;
}) {
  // 0 is a legitimate, meaningful answer for every one of these three
  // counts ("no external involvement" / "nothing currently pending") --
  // shown as a plain 0 via the normal stat grid below, never hidden behind
  // an empty state.
  return (
    <div className="surface p-4 sm:p-5">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="תקלות שנגרמו מגורם חיצוני (בתקופה)" value={causeExternalClosedCount} />
        <Stat label="פתרון שיוחס לגורם חיצוני (בתקופה)" value={resolutionAttributionExternalCount} />
      </div>
      <div className="mt-4 border-t border-hairline pt-4">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-surface-active px-2 py-0.5 text-[11px] font-medium text-text-secondary">
            כרגע
          </span>
          <span className="text-xs text-muted">לא מוגבל לתקופה שנבחרה</span>
        </div>
        <div className="mt-2">
          <Stat label="תקלות פתוחות התלויות בגורם חיצוני" value={externallyHandledOpenCount} />
        </div>
      </div>
    </div>
  );
}
