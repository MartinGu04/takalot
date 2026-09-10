// Reusable presentation rule for the Timeline: decides whether a
// field-level delta's DISPLAYED value is short enough to render inline as
// "before → after", or long enough that it should collapse into a compact
// one-word summary with the full values moved behind "פרטים נוספים".
//
// Deliberately keyed on the rendered value's length/shape only -- never on
// which field it is. A field like external_handler (a composed
// name/contact snapshot) or operational_impact (free text) can be short
// today and long tomorrow depending on what a user actually typed; a
// field-name allowlist would miss that. This stays a pure, isolated,
// single-purpose module so the threshold is trivial to find and adjust
// later without touching rendering code.
export const LONG_DELTA_VALUE_THRESHOLD = 28;

export function isLongDeltaValue(value: string): boolean {
  return value.length > LONG_DELTA_VALUE_THRESHOLD;
}

/** True when either side of the transition is long enough to need
 *  collapsing -- a long "before" with a short "after" (or vice versa)
 *  still shouldn't render its long side inline. `before` is `null` for a
 *  delta with no meaningful previous value (rendered as a single value,
 *  never a transition) -- only `after` is checked in that case. */
export function isLongFieldDelta(before: string | null, after: string): boolean {
  return (before != null && isLongDeltaValue(before)) || isLongDeltaValue(after);
}
