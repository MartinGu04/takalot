export const NO_DEADLINE_LABEL = 'ללא צפי כרגע';

/**
 * Returns a real, user-supplied explanation for a missing update deadline.
 * Historical records may contain the generic display label itself as the
 * stored reason; that value carries no additional meaning and is therefore
 * treated like an absent explanation.
 */
export function meaningfulNoDeadlineReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? '';
  return trimmed && trimmed !== NO_DEADLINE_LABEL ? trimmed : null;
}
