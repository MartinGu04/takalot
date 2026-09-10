// Timeline: focused rendering tests for the compact, scannable redesign.
// Grouping algorithm correctness itself is covered by
// domain/timelineGrouping.test.ts (pure, no DOM); event-kind classification
// by domain/timelineEventKind.test.ts; this file covers what actually
// reaches the screen.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Timeline } from './Timeline';
import type { IncidentEvent, IncidentUpdate, Profile } from '../domain/types';

function ev(overrides: Partial<IncidentEvent> & { id: string }): IncidentEvent {
  return {
    incidentId: 'inc-1',
    type: 'update',
    actorId: 'u1',
    actorLabel: null,
    eventTime: '2026-01-10T08:00:00.000Z',
    serverTime: '2026-01-10T08:00:00.000Z',
    field: null,
    oldValue: null,
    newValue: null,
    note: null,
    userNote: null,
    refId: null,
    createdAt: '2026-01-10T08:00:00.000Z',
    operationId: null,
    ...overrides,
  };
}

function upd(overrides: Partial<IncidentUpdate> & { id: string }): IncidentUpdate {
  return {
    incidentId: 'inc-1',
    authorId: 'u1',
    eventTime: '2026-01-10T08:00:00.000Z',
    serverTime: '2026-01-10T08:00:00.000Z',
    actionsTaken: 'פעולות שבוצעו לבדיקה',
    findings: '',
    nextSteps: '',
    currentStatusText: null,
    updateReportedToOps: null,
    updateReportedToOpsRecipient: null,
    updateReportedToComms: null,
    updateReportedToCommsRecipient: null,
    updateWisdomReported: null,
    userNote: null,
    createdAt: '2026-01-10T08:00:00.000Z',
    ...overrides,
  };
}

const profiles: Profile[] = [
  { id: 'u1', fullName: 'יואב כהן', role: 'shift_supervisor', active: true, createdAt: '2026-01-01T00:00:00.000Z' },
];

/** The colored circular marker for an entry -- distinct from the date
 *  separator's own aria-hidden elements (the vertical line segment and the
 *  small dot), which never carry `rounded-full`. */
function roundel(container: HTMLElement): HTMLElement {
  return container.querySelector('[aria-hidden="true"][class*="rounded-full"]') as HTMLElement;
}

describe('Timeline: one operation renders as one item', () => {
  it('a grouped update (3 backing rows, one operationId) renders one title/icon and its subordinate changes as nested compact rows, never a boxed section', () => {
    const events = [
      ev({ id: 'e-update', type: 'update', operationId: 'op-1', refId: 'upd-1' }),
      ev({ id: 'e-status', type: 'status_change', operationId: 'op-1', field: 'status', oldValue: 'in_progress', newValue: 'monitoring' }),
      ev({ id: 'e-severity', type: 'severity_change', operationId: 'op-1', field: 'severity', oldValue: 'high', newValue: 'medium' }),
    ];
    const updates = [upd({ id: 'upd-1', actionsTaken: 'תוכן העדכון היחיד' })];
    const { container } = render(<Timeline events={events} updates={updates} profiles={profiles} />);

    // The update title/content appear exactly once despite 3 backing rows,
    // and it's a single timeline entry (one marker), not three.
    expect(screen.getAllByText('עדכון טיפול')).toHaveLength(1);
    expect(screen.getAllByText('תוכן העדכון היחיד')).toHaveLength(1);
    expect(container.querySelectorAll('li[id^="timeline-entry-"]')).toHaveLength(1);

    // Both subordinate changes render as compact field-label rows, fully
    // visible without opening any disclosure -- no "שינויים בעדכון" box.
    expect(screen.queryByText('שינויים בעדכון')).not.toBeInTheDocument();
    expect(screen.queryByText('שינויים נוספים')).not.toBeInTheDocument();
    expect(screen.getByText('סטטוס:')).toBeInTheDocument();
    expect(screen.getByText('חומרה:')).toBeInTheDocument();
    expect(screen.getByText('בטיפול')).toBeInTheDocument();
    expect(screen.getByText('במעקב')).toBeInTheDocument();
  });

  it('operationId=null rows never merge, even when they share type and eventTime', () => {
    const events = [
      ev({ id: 'e1', type: 'update', operationId: null, refId: 'upd-1', eventTime: '2025-01-01T00:00:00.000Z' }),
      ev({ id: 'e2', type: 'update', operationId: null, refId: 'upd-2', eventTime: '2025-01-01T00:00:00.000Z' }),
    ];
    const updates = [
      upd({ id: 'upd-1', actionsTaken: 'עדכון ראשון היסטורי' }),
      upd({ id: 'upd-2', actionsTaken: 'עדכון שני היסטורי' }),
    ];
    const { container } = render(<Timeline events={events} updates={updates} profiles={profiles} />);

    expect(screen.getAllByText('עדכון טיפול')).toHaveLength(2);
    expect(screen.getByText('עדכון ראשון היסטורי')).toBeInTheDocument();
    expect(screen.getByText('עדכון שני היסטורי')).toBeInTheDocument();
    // Two independent entries.
    expect(container.querySelectorAll('li[id^="timeline-entry-"]')).toHaveLength(2);
  });
});

describe('Timeline: lifecycle emphasis', () => {
  it('a created group gets the solid brand (purple) marker', () => {
    const { container } = render(
      <Timeline events={[ev({ id: 'e1', type: 'created', operationId: 'op-1', note: 'פתיחת תקלה' })]} updates={[]} profiles={profiles} />,
    );
    expect(roundel(container).className).toContain('bg-brand-600');
  });

  it('partial-readiness (status_change -> partial_readiness) gets a rich card with an explicit "still active" note, never the closure color', () => {
    const events = [
      ev({ id: 'e-status', type: 'status_change', operationId: 'op-1', field: 'status', oldValue: 'in_progress', newValue: 'partial_readiness', note: 'סיבת התקלה: X' }),
    ];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);

    expect(roundel(container).className).not.toContain('bg-green-600');
    expect(screen.getByText(/התקלה נותרת פעילה/)).toBeInTheDocument();
    // The generic field diff still shows what actually changed.
    expect(screen.getByText('כשירות חלקית')).toBeInTheDocument();
  });

  it('a full-readiness close gets the solid green (closure) marker and does not show the "still active" note', () => {
    const events = [ev({ id: 'e-closed', type: 'closed', operationId: 'op-1', newValue: 'full', note: 'סיבת התקלה: X\nהפתרון שבוצע: Y' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(roundel(container).className).toContain('bg-green-600');
    expect(screen.queryByText(/התקלה נותרת פעילה/)).not.toBeInTheDocument();
  });
});

describe('Timeline: event-type classification (color + icon)', () => {
  it('עדכון טיפול gets the solid blue marker', () => {
    const events = [ev({ id: 'e1', type: 'update', operationId: 'op-1', refId: 'upd-1' })];
    const { container } = render(<Timeline events={events} updates={[upd({ id: 'upd-1' })]} profiles={profiles} />);
    expect(roundel(container).className).toContain('bg-blue-600');
  });

  it('שינוי סטטוס gets a muted amber marker (a compact row, not a rich card)', () => {
    const events = [ev({ id: 'e1', type: 'status_change', operationId: 'op-1', field: 'status', oldValue: 'new', newValue: 'in_progress' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(roundel(container).className).toContain('bg-yellow-100');
    expect(roundel(container).className).not.toContain('bg-yellow-500');
  });

  it('דיווח למבצעים gets a muted orange marker', () => {
    const events = [ev({ id: 'e1', type: 'reported_to_ops_change', operationId: 'op-1', note: 'דווח למבצעים: yes' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(roundel(container).className).toContain('bg-orange-100');
  });

  it('סגירת תקלה gets the solid green marker', () => {
    const events = [ev({ id: 'e1', type: 'closed', operationId: 'op-1', newValue: 'full' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(roundel(container).className).toContain('bg-green-600');
  });

  it('פתיחה מחדש gets the solid red marker', () => {
    const events = [ev({ id: 'e1', type: 'reopened', operationId: 'op-1' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(roundel(container).className).toContain('bg-red-600');
    expect(screen.getByText('פתיחה מחדש')).toBeInTheDocument();
  });
});

describe('Timeline: date grouping', () => {
  it('shows one date separator for multiple events on the same calendar date, each event showing only its time', () => {
    const events = [
      // 2026-09-10 is DST in Asia/Jerusalem (UTC+3).
      ev({ id: 'e1', type: 'created', operationId: 'op-1', eventTime: '2026-09-10T07:15:00.000Z' }),
      ev({ id: 'e2', type: 'status_change', operationId: 'op-2', field: 'status', oldValue: 'new', newValue: 'in_progress', eventTime: '2026-09-10T08:35:00.000Z' }),
      ev({ id: 'e3', type: 'closed', operationId: 'op-3', newValue: 'full', eventTime: '2026-09-10T08:45:00.000Z' }),
    ];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);

    expect(screen.getAllByText('10.09.2026')).toHaveLength(1);
    expect(screen.getByText('10:15')).toBeInTheDocument();
    expect(screen.getByText('11:35')).toBeInTheDocument();
    expect(screen.getByText('11:45')).toBeInTheDocument();
    // No event repeats the full date next to its time.
    expect(screen.queryByText('10.09.2026, 10:15')).not.toBeInTheDocument();
  });

  it('shows a separate date separator for each calendar date crossed', () => {
    const events = [
      ev({ id: 'e1', type: 'created', operationId: 'op-1', eventTime: '2026-09-10T07:00:00.000Z' }),
      ev({ id: 'e2', type: 'closed', operationId: 'op-2', newValue: 'full', eventTime: '2026-09-11T07:00:00.000Z' }),
    ];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText('10.09.2026')).toBeInTheDocument();
    expect(screen.getByText('11.09.2026')).toBeInTheDocument();
  });
});

describe('Timeline: compact field-delta rendering', () => {
  it('renders a compact status transition inline, with both explicit values and no boxed section', () => {
    const events = [ev({ id: 'e-status', type: 'status_change', operationId: 'op-1', field: 'status', oldValue: 'new', newValue: 'in_progress' })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText('סטטוס:')).toBeInTheDocument();
    expect(screen.getByText('חדשה')).toBeInTheDocument();
    expect(screen.getByText('בטיפול')).toBeInTheDocument();
    expect(screen.queryByText('שינויים נוספים')).not.toBeInTheDocument();
  });

  it('keeps explicit לפני/אחרי semantics for assistive tech even though the visual row is compact', () => {
    const events = [ev({ id: 'e-status', type: 'status_change', operationId: 'op-1', field: 'status', oldValue: 'new', newValue: 'in_progress' })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText('לפני:')).toBeInTheDocument();
    expect(screen.getByText('אחרי:')).toBeInTheDocument();
  });

  it('renders a compact single-line reporting-to-operations summary', () => {
    const events = [ev({ id: 'e-ops', type: 'reported_to_ops_change', operationId: 'op-1', oldValue: null, newValue: null, note: 'דיווח למבצעים: אסף' })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText('דווח למבצעים:')).toBeInTheDocument();
    expect(screen.getByText('דיווח למבצעים: אסף')).toBeInTheDocument();
  });

  it('shows the previous recipient as "לפני" when a reporting change has one, instead of dropping it', () => {
    const events = [ev({ id: 'e-ops', type: 'reported_to_ops_change', operationId: 'op-1', oldValue: 'דנה', newValue: null, note: 'דיווח למבצעים: אסף' })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText('דנה')).toBeInTheDocument();
    expect(screen.getByText('דיווח למבצעים: אסף')).toBeInTheDocument();
  });
});

describe('Timeline: server time secondary line', () => {
  it('shows "תועד במערכת:" only when server time differs from event time by more than 60s', () => {
    const close = ev({
      id: 'e1',
      type: 'closed',
      operationId: 'op-1',
      newValue: 'full',
      eventTime: '2026-01-10T06:00:00.000Z',
      serverTime: '2026-01-10T08:00:00.000Z',
    });
    render(<Timeline events={[close]} updates={[]} profiles={profiles} />);
    expect(screen.getByText(/תועד במערכת:/)).toBeInTheDocument();
  });

  it('hides the secondary line when the two timestamps are within 60s', () => {
    const close = ev({
      id: 'e1',
      type: 'closed',
      operationId: 'op-1',
      newValue: 'full',
      eventTime: '2026-01-10T08:00:00.000Z',
      serverTime: '2026-01-10T08:00:30.000Z',
    });
    render(<Timeline events={[close]} updates={[]} profiles={profiles} />);
    expect(screen.queryByText(/תועד במערכת:/)).not.toBeInTheDocument();
  });
});

describe('Timeline: reported_to_ops_change consolidation', () => {
  it('renders the recipient diff and the full status once, with no separate duplicated note paragraph', () => {
    const events = [
      ev({ id: 'e-created', type: 'created', operationId: 'op-1', note: 'פתיחת תקלה' }),
      ev({
        id: 'e-ops',
        type: 'reported_to_ops_change',
        operationId: 'op-1',
        field: 'reported_to_ops_recipient',
        oldValue: null,
        newValue: 'יוסי',
        note: 'דווח למבצעים: yes (יוסי)',
      }),
    ];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    // The note text appears exactly once (as the "אחרי" value), not twice.
    expect(screen.getAllByText('דווח למבצעים: yes (יוסי)')).toHaveLength(1);
  });
});

describe('Timeline: per-row correction targeting inside a grouped update', () => {
  it('each correctable row gets its own correction action, wired to its own target id', async () => {
    const onCorrect = vi.fn();
    const events = [
      ev({ id: 'e-update', type: 'update', operationId: 'op-1', refId: 'upd-1', actorId: 'u1' }),
      ev({ id: 'e-status', type: 'status_change', operationId: 'op-1', field: 'status', oldValue: 'in_progress', newValue: 'monitoring', actorId: 'u1' }),
    ];
    const updates = [upd({ id: 'upd-1' })];
    render(
      <Timeline
        events={events}
        updates={updates}
        profiles={profiles}
        currentUserId="u1"
        onCorrect={onCorrect}
      />,
    );

    const buttons = screen.getAllByRole('button', { name: 'תיקון רישום זה' });
    // One for the primary (update, targets the incident_updates id), one for the subordinate status_change (targets its own event id).
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(onCorrect).toHaveBeenCalledWith('e-status', expect.stringContaining('שינוי סטטוס'));
  });

  it('does not offer a correction action for non-correctable subordinate types (e.g. reported_to_ops_change)', () => {
    const onCorrect = vi.fn();
    const events = [
      ev({ id: 'e-update', type: 'update', operationId: 'op-1', refId: 'upd-1', actorId: 'u1' }),
      ev({ id: 'e-ops', type: 'reported_to_ops_change', operationId: 'op-1', note: 'דווח למבצעים: yes', actorId: 'u1' }),
    ];
    render(
      <Timeline
        events={events}
        updates={[upd({ id: 'upd-1' })]}
        profiles={profiles}
        currentUserId="u1"
        onCorrect={onCorrect}
      />,
    );
    expect(screen.getAllByRole('button', { name: 'תיקון רישום זה' })).toHaveLength(1);
  });
});

describe('Timeline: grouped status-check completion', () => {
  it('completion is primary; the next-scheduled check nests inside the same entry, not a separate one', () => {
    const events = [
      ev({ id: 'e-open', type: 'status_check_changed', operationId: 'op-1', field: 'status_check_due', oldValue: null, newValue: '2026-02-01T00:00:00.000Z' }),
      ev({ id: 'e-close', type: 'status_check_changed', operationId: 'op-1', field: 'status_check_due', oldValue: '2026-01-15T00:00:00.000Z', newValue: null }),
    ];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(container.querySelectorAll('li[id^="timeline-entry-"]')).toHaveLength(1);
    expect(screen.getAllByText('עדכון בדיקת סטטוס')).toHaveLength(1);
  });
});

describe('Timeline: closure event operational duration', () => {
  // Israel is on DST (UTC+3) in July; 19.07.2026 16:05/16:06 local is
  // 13:05/13:06 UTC. The event's own eventTime/serverTime are deliberately
  // set to a much later recording moment (02.08.2026) to prove the
  // duration line is computed from the incident's discoveredAt/closedAt,
  // never from the event's recording timestamp or the current clock.
  const DISCOVERED_AT = '2026-07-19T13:05:00.000Z';
  const CLOSED_AT = '2026-07-19T13:06:00.000Z';
  const RECORDED_AT = '2026-08-02T10:00:00.000Z';

  it('shows "משך התקלה: דקה אחת" in bold, always visible, for a closure recorded weeks after it actually happened', () => {
    const close = ev({
      id: 'e-closed',
      type: 'closed',
      operationId: 'op-1',
      newValue: 'full',
      note: 'סיבת התקלה: X\nהפתרון שבוצע: Y',
      eventTime: CLOSED_AT,
      serverTime: RECORDED_AT,
    });
    render(
      <Timeline
        events={[close]}
        updates={[]}
        profiles={profiles}
        discoveredAt={DISCOVERED_AT}
        closedAt={CLOSED_AT}
      />,
    );

    // Visible immediately, without opening "פרטים נוספים".
    const line = screen.getByText(/משך התקלה: דקה אחת/);
    expect(line).toBeInTheDocument();
    expect(line.className).toContain('font-bold');
  });

  it('does not render a duration line when discoveredAt/closedAt are not supplied', () => {
    const close = ev({ id: 'e-closed', type: 'closed', operationId: 'op-1', newValue: 'full' });
    render(<Timeline events={[close]} updates={[]} profiles={profiles} />);
    expect(screen.queryByText(/משך התקלה:/)).not.toBeInTheDocument();
  });

  it('does not render a duration line for non-closure events even when discoveredAt/closedAt are supplied', () => {
    const events = [ev({ id: 'e1', type: 'update', operationId: 'op-1' })];
    render(
      <Timeline
        events={events}
        updates={[]}
        profiles={profiles}
        discoveredAt={DISCOVERED_AT}
        closedAt={CLOSED_AT}
      />,
    );
    expect(screen.queryByText(/משך התקלה:/)).not.toBeInTheDocument();
  });
});

// "הערה נוספת" (migration 0038): a distinct, clearly-labeled optional note,
// separate from the existing generated note text and from any update's own
// structured fields -- never shown when absent. Both generated notes and
// user notes are verbose/secondary content, so they now live behind
// "פרטים נוספים" -- never removed, just not shown until asked for.
describe('Timeline: "הערה נוספת" (user note)', () => {
  it('shows the user note inside a grouped update, behind "פרטים נוספים", alongside its own structured fields', () => {
    const events = [ev({ id: 'e-update', type: 'update', operationId: 'op-1', refId: 'upd-1' })];
    const updates = [upd({ id: 'upd-1', actionsTaken: 'תוכן העדכון', userNote: 'הערה נוספת שהוזנה בעדכון' })];
    render(<Timeline events={events} updates={updates} profiles={profiles} />);

    // The core content is visible immediately.
    expect(screen.getByText('תוכן העדכון')).toBeInTheDocument();
    expect(screen.queryByText('הערה נוספת:')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'פרטים נוספים' }));
    expect(screen.getByText('הערה נוספת:')).toBeInTheDocument();
    expect(screen.getByText('הערה נוספת שהוזנה בעדכון')).toBeInTheDocument();
    // The summary is still visible after opening the details section.
    expect(screen.getByText('תוכן העדכון')).toBeInTheDocument();
  });

  it('shows no "הערה נוספת" line -- and no details control at all -- for an update with no user note, findings, or next steps', () => {
    const events = [ev({ id: 'e-update', type: 'update', operationId: 'op-1', refId: 'upd-1' })];
    const updates = [upd({ id: 'upd-1', actionsTaken: 'תוכן העדכון', userNote: null })];
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    expect(screen.queryByText('הערה נוספת:')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'פרטים נוספים' })).not.toBeInTheDocument();
  });

  it('shows the user note on a "created" event immediately, distinct from its own generated note -- both are core, not verbose detail', () => {
    const events = [
      ev({
        id: 'e-created',
        type: 'created',
        operationId: 'op-1',
        note: 'פעולות שבוצעו עד כה: בדיקה ראשונית',
        userNote: 'התקלה דווחה טלפונית',
      }),
    ];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText(/פעולות שבוצעו עד כה: בדיקה ראשונית/)).toBeInTheDocument();
    expect(screen.getByText('הערה נוספת:')).toBeInTheDocument();
    expect(screen.getByText('התקלה דווחה טלפונית')).toBeInTheDocument();
    // Nothing verbose left to hide, so no details control appears at all.
    expect(screen.queryByRole('button', { name: 'פרטים נוספים' })).not.toBeInTheDocument();
  });

  it('shows the user note on a "closed" event, behind "פרטים נוספים", distinct from its own generated note', () => {
    const events = [
      ev({
        id: 'e-closed',
        type: 'closed',
        operationId: 'op-1',
        newValue: 'full',
        note: 'סיבת התקלה: X\nהפתרון שבוצע: Y',
        userNote: 'הערה נוספת בעת הסגירה',
      }),
    ];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    fireEvent.click(screen.getByRole('button', { name: 'פרטים נוספים' }));
    expect(screen.getByText(/סיבת התקלה: X/)).toBeInTheDocument();
    expect(screen.getByText('הערה נוספת:')).toBeInTheDocument();
    expect(screen.getByText('הערה נוספת בעת הסגירה')).toBeInTheDocument();
  });

  it('omits the "הערה נוספת" line when a created event has a generated note but no separate user note', () => {
    const events = [ev({ id: 'e-created', type: 'created', operationId: 'op-1', note: 'פעולות שבוצעו עד כה: X', userNote: null })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText(/פעולות שבוצעו עד כה: X/)).toBeInTheDocument();
    expect(screen.queryByText('הערה נוספת:')).not.toBeInTheDocument();
  });
});

describe('Timeline: "פרטים נוספים" details disclosure', () => {
  it('shows no details control at all for a created event with neither a note nor a user note', () => {
    const events = [ev({ id: 'e-created', type: 'created', operationId: 'op-1', note: null, userNote: null })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.queryByRole('button', { name: 'פרטים נוספים' })).not.toBeInTheDocument();
  });

  it('shows no details control for a simple compact field-delta event (nothing verbose to hide)', () => {
    const events = [ev({ id: 'e-status', type: 'status_change', operationId: 'op-1', field: 'status', oldValue: 'new', newValue: 'in_progress' })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.queryByRole('button', { name: 'פרטים נוספים' })).not.toBeInTheDocument();
  });

  it('reveals verbose content on demand, is accessibly labeled, and never hides the event summary', () => {
    const events = [ev({ id: 'e1', type: 'closed', operationId: 'op-1', newValue: 'full', note: 'סיבת התקלה: X\nהפתרון שבוצע: Y' })];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);

    // Summary visible immediately; verbose narrative starts hidden.
    expect(screen.getByText(/כשירות בסגירה/)).toBeInTheDocument();
    expect(screen.queryByText(/סיבת התקלה: X/)).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'פרטים נוספים' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Now visible, and the summary is still visible too.
    expect(screen.getByText(/סיבת התקלה: X/)).toBeInTheDocument();
    expect(screen.getByText(/כשירות בסגירה/)).toBeInTheDocument();
  });
});

describe('Timeline: empty state', () => {
  it('shows the empty message when there are no events', () => {
    render(<Timeline events={[]} updates={[]} profiles={profiles} />);
    expect(screen.getByText('אין אירועים בציר הזמן.')).toBeInTheDocument();
  });
});

// A correction is an audit entry that amends a previous record, not a new
// treatment update -- it must render as its own distinct entry, never as a
// near-duplicate of the original update's full status/actions/findings/
// next-steps card. 02.08.2026T18:46 UTC is 21:46 Asia/Jerusalem (DST, UTC+3
// in August), matching the exact worked example in the spec.
describe('Timeline: record corrections render as distinct audit entries', () => {
  const ORIGINAL_UPDATE_TIME = '2026-08-02T18:46:00.000Z';

  function correctionFixture(overrides: Partial<IncidentEvent> = {}) {
    const events = [
      ev({ id: 'e-update', type: 'update', operationId: 'op-1', refId: 'upd-1', eventTime: ORIGINAL_UPDATE_TIME }),
      ev({
        id: 'e-correction',
        type: 'correction',
        operationId: 'op-2',
        refId: 'upd-1',
        note: 'שעת האירוע היא 21:40',
        ...overrides,
      }),
    ];
    const updates = [
      upd({
        id: 'upd-1',
        eventTime: ORIGINAL_UPDATE_TIME,
        actionsTaken: 'פעולות שבוצעו במקור',
        findings: 'ממצאים מקוריים',
        nextSteps: 'צעדים הבאים במקור',
      }),
    ];
    return { events, updates };
  }

  it('titles a correction "תיקון לרישום קודם", not the generic event-type label', () => {
    const { events, updates } = correctionFixture();
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    expect(screen.getByText('תיקון לרישום קודם')).toBeInTheDocument();
    // Never the generic label used elsewhere for this same event type.
    expect(screen.queryByText('תיקון רישום')).not.toBeInTheDocument();
  });

  it('shows the persisted correction note prominently with a "תיקון:" prefix', () => {
    const { events, updates } = correctionFixture();
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    expect(screen.getByText('תיקון:')).toBeInTheDocument();
    expect(screen.getByText('שעת האירוע היא 21:40')).toBeInTheDocument();
  });

  it("does not repeat the corrected update's own actions/findings/next-steps fields", () => {
    const { events, updates } = correctionFixture();
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    // actionsTaken stays in the primary summary, always visible.
    expect(screen.getAllByText('פעולות שבוצעו במקור')).toHaveLength(1);
    // findings/nextSteps are verbose detail on the original entry -- open
    // it and confirm they still appear exactly once, never duplicated onto
    // the correction entry beside it.
    fireEvent.click(screen.getByRole('button', { name: 'פרטים נוספים' }));
    expect(screen.getAllByText('ממצאים מקוריים')).toHaveLength(1);
    expect(screen.getAllByText('צעדים הבאים במקור')).toHaveLength(1);
  });

  it('references the correct original timeline entry, using the real refId relationship and its actual recorded date/time', () => {
    const { events, updates } = correctionFixture();
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    expect(screen.getByText('מתייחס לעדכון הטיפול מ־02.08.2026 בשעה 21:46')).toBeInTheDocument();
  });

  it('leaves the original entry fully intact and adds a small "corrected later" indication to it', () => {
    const { events, updates } = correctionFixture();
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    // Original entry: title and primary content unaffected.
    expect(screen.getByText('עדכון טיפול')).toBeInTheDocument();
    expect(screen.getByText('פעולות שבוצעו במקור')).toBeInTheDocument();
    expect(screen.getByText('רישום זה תוקן בהמשך')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'פרטים נוספים' }));
    expect(screen.getByText('ממצאים מקוריים')).toBeInTheDocument();
  });

  it('does not show the "corrected later" indication on an entry with no correction', () => {
    const events = [ev({ id: 'e-update', type: 'update', operationId: 'op-1', refId: 'upd-1' })];
    const updates = [upd({ id: 'upd-1' })];
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    expect(screen.queryByText('רישום זה תוקן בהמשך')).not.toBeInTheDocument();
  });

  it('shows an accurate structured field-level diff when a correction genuinely carries one, via the existing generic field-diff rendering', () => {
    const { events, updates } = correctionFixture({
      field: 'operational_impact',
      oldValue: 'השפעה ישנה',
      newValue: 'השפעה מתוקנת',
      note: null,
    });
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    expect(screen.getByText('השפעה מבצעית:')).toBeInTheDocument();
    expect(screen.getByText('השפעה ישנה')).toBeInTheDocument();
    expect(screen.getByText('השפעה מתוקנת')).toBeInTheDocument();
    // No free-text "תיקון:" block when there is no note to show.
    expect(screen.queryByText('תיקון:')).not.toBeInTheDocument();
  });

  it('renders free-text correction content verbatim, never rewritten into a more specific claim than what was actually entered', () => {
    const { events, updates } = correctionFixture({ note: 'יש לתקן את השעה בהמשך, לבדוק מול הטכנאי' });
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    expect(screen.getByText('יש לתקן את השעה בהמשך, לבדוק מול הטכנאי')).toBeInTheDocument();
    // No invented specific claim beyond what the technician actually typed.
    expect(screen.queryByText(/תוקנה מ/)).not.toBeInTheDocument();
  });

  it('keeps Hebrew, English and mixed-direction correction content readable via bidirectional isolation', () => {
    const { events, updates } = correctionFixture({ note: 'תוקן ל-Server-42, שעה 21:40' });
    render(<Timeline events={events} updates={updates} profiles={profiles} />);
    const value = screen.getByText('תוקן ל-Server-42, שעה 21:40');
    expect(value.tagName).toBe('BDI');
    expect(value).toHaveAttribute('dir', 'auto');
  });

  it('other timeline event types keep their existing presentation, unaffected by the correction-rendering changes', () => {
    const events = [
      ev({ id: 'e-closed', type: 'closed', operationId: 'op-1', newValue: 'full', note: 'סיבת התקלה: X\nהפתרון שבוצע: Y' }),
    ];
    render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(screen.getByText('סגירת תקלה')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'פרטים נוספים' }));
    expect(screen.getByText(/סיבת התקלה: X/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Actor identity (avatar)
// ---------------------------------------------------------------------------

describe('Timeline: actor identity', () => {
  it("shows a human actor's real stored avatar image beside their name", () => {
    const events = [ev({ id: 'e1', type: 'acknowledged', actorId: 'u-photo' })];
    const withPhoto: Profile[] = [
      {
        id: 'u-photo',
        fullName: 'דנה לוי',
        role: 'shift_supervisor',
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
      },
    ];
    const { container } = render(<Timeline events={events} updates={[]} profiles={withPhoto} />);
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/photo');
    expect(screen.getByText('דנה לוי')).toBeInTheDocument();
  });

  it('falls back to an initial for a human actor with no stored avatar', () => {
    const events = [ev({ id: 'e1', type: 'acknowledged', actorId: 'u1' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(container.querySelector('img')).toBeNull();
    // 'יואב כהן' -> initial 'י'
    expect(container.textContent).toContain('י');
    expect(screen.getByText('יואב כהן')).toBeInTheDocument();
  });

  it('renders no avatar for a system-generated event (no actor id at all)', () => {
    const events = [ev({ id: 'e1', type: 'status_change', actorId: null, field: 'status', newValue: 'monitoring' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('המערכת')).toBeInTheDocument();
  });

  it('renders no avatar for an external actor label, even though actorId happens to be set -- never a fictional person', () => {
    const events = [ev({ id: 'e1', type: 'update', actorId: 'u1', actorLabel: 'אלתא (IAF)' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('אלתא (IAF)')).toBeInTheDocument();
  });

  it('a human actor whose profile is unavailable still renders understandably: generic fallback text, generic fallback initial, no crash', () => {
    const events = [ev({ id: 'e1', type: 'acknowledged', actorId: 'u-unknown' })];
    const { container } = render(<Timeline events={events} updates={[]} profiles={profiles} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('משתמש')).toBeInTheDocument();
  });
});
