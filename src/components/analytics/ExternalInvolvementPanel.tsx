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
//
// Presentation: three compact metric cards, deliberately quieter than
// AnalyticsKpiCard (no icon, no tone-colored background/border) -- this
// module is a supporting detail panel, not a second KPI row.
function ExternalStatCard({ label, value, caption }: { label: string; value: number; caption?: string }) {
  return (
    <div className="surface flex min-w-0 flex-col gap-1.5 border border-hairline p-4">
      {caption && (
        // The one card whose count is NOT period-scoped gets this caption --
        // must stay legible as one clear phrase, never split into a louder
        // badge + separate note (that read as more prominent than the other
        // two cards, which is the opposite of "quieter than the KPI row").
        <span className="text-xs font-medium text-muted">{caption}</span>
      )}
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
  // shown as a plain 0 via the normal stat cards below, never hidden behind
  // an empty state.
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <ExternalStatCard label="תקלות שנסגרו עם גורם חיצוני בתקופה" value={causeExternalClosedCount} />
      <ExternalStatCard label="פתרון שיוחס לגורם חיצוני בתקופה" value={resolutionAttributionExternalCount} />
      <ExternalStatCard
        label="תקלות פתוחות שתלויות כרגע בגורם חיצוני"
        value={externallyHandledOpenCount}
        caption="כעת · לא מוגבל לתקופה שנבחרה"
      />
    </div>
  );
}
