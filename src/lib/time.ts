// Timestamps are stored as ISO UTC and displayed in Asia/Jerusalem, 24-hour clock.
const TZ = 'Asia/Jerusalem';

const dateTimeFmt = new Intl.DateTimeFormat('he-IL', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateFmt = new Intl.DateTimeFormat('he-IL', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const timeFmt = new Intl.DateTimeFormat('he-IL', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateTimeFmt.format(new Date(iso));
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateFmt.format(new Date(iso));
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return timeFmt.format(new Date(iso));
}

/** Day/hour/minute breakdown + Hebrew pluralization + joining, shared by
 *  formatDuration (two timestamps) and formatDurationMinutes (a raw
 *  minute count, e.g. an average from the analytics RPC). */
function formatMinutesHebrew(totalMinutes: number): string {
  let minutes = Math.max(0, Math.round(totalMinutes));
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(days === 1 ? 'יום אחד' : `${days} ימים`);
  if (hours > 0) parts.push(hours === 1 ? 'שעה אחת' : `${hours} שעות`);
  if (minutes > 0 || parts.length === 0) parts.push(minutes === 1 ? 'דקה אחת' : `${minutes} דקות`);
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' ו־' + parts[parts.length - 1];
}

/** Duration between two ISO timestamps as Hebrew text, e.g. "3 שעות ו־20 דקות". */
export function formatDuration(fromIso: string, toIso: string): string {
  return formatMinutesHebrew((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000);
}

/** Compact Hebrew duration for analytics display only (KPI cards averaging
 *  a raw minute count) -- numeral + unit, at most TWO components (days +
 *  hours, or hours + minutes, or minutes alone), never three. Presentation
 *  only, deliberately terser than formatDuration's fuller "X ימים, Y שעות
 *  ו־Z דקות" (still used everywhere else -- incident detail, exports):
 *  once the leading unit is days or hours, the next-smaller unit rounds
 *  away rather than adding a third clause, since for an average duration
 *  that level of precision reads as noise, not information. E.g. 2380
 *  minutes -> "1 יום, 15 שעות", not "יום אחד, 15 שעות ו־40 דקות". null (no
 *  data to average, e.g. nothing closed in the selected period) renders as
 *  '—', matching this file's existing null convention (formatDate(null)
 *  etc.), not an invented "0 דקות". */
export function formatDurationMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  let total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  total -= days * 1440;
  const hours = Math.floor(total / 60);
  total -= hours * 60;
  const mins = total;

  const unit = (n: number, singular: string, plural: string) => `${n} ${n === 1 ? singular : plural}`;

  if (days > 0) {
    return hours > 0
      ? `${unit(days, 'יום', 'ימים')}, ${unit(hours, 'שעה', 'שעות')}`
      : unit(days, 'יום', 'ימים');
  }
  if (hours > 0) {
    return mins > 0
      ? `${unit(hours, 'שעה', 'שעות')}, ${unit(mins, 'דקה', 'דקות')}`
      : unit(hours, 'שעה', 'שעות');
  }
  return unit(mins, 'דקה', 'דקות');
}

/** Relative Hebrew text, e.g. "לפני 18 דקות" / "בעוד שעתיים". */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diffMin = Math.round((new Date(iso).getTime() - now.getTime()) / 60000);
  const abs = Math.abs(diffMin);
  const future = diffMin > 0;
  let unitText: string;
  if (abs < 1) return 'עכשיו';
  if (abs < 60) unitText = abs === 1 ? 'דקה' : `${abs} דקות`;
  else if (abs < 1440) {
    const h = Math.round(abs / 60);
    unitText = h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
  } else {
    const d = Math.round(abs / 1440);
    unitText = d === 1 ? 'יום' : d === 2 ? 'יומיים' : `${d} ימים`;
  }
  return future ? `בעוד ${unitText}` : `לפני ${unitText}`;
}

/**
 * Convert an ISO UTC timestamp to the value format of <input type="datetime-local">
 * expressed in Asia/Jerusalem local time, and back.
 */
// Memoized / reused Intl.DateTimeFormat formatters to avoid expensive re-creation
const enCaDateTimeFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const enCaYearFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
});

export function isoToLocalInput(iso: string): string {
  const parts = enCaDateTimeFmt.formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  let hour = get('hour');
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

export function localInputToIso(local: string): string {
  // Interpret the wall-clock value as Asia/Jerusalem time.
  const [datePart, timePart] = local.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  // Find the UTC instant whose Jerusalem wall clock matches.
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  for (const offsetMin of [-180, -120, -60, 0]) {
    const candidate = new Date(guess + offsetMin * 60000);
    const back = isoToLocalInput(candidate.toISOString());
    if (back === local) return candidate.toISOString();
  }
  // Fallback: assume +02:00 (IST standard time)
  return new Date(guess - 120 * 60000).toISOString();
}

/** Current year in Asia/Jerusalem — used for incident numbering. */
export function jerusalemYear(now: Date = new Date()): number {
  return Number(enCaYearFmt.format(now));
}
