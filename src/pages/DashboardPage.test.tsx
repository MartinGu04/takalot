// "מצב נוכחי" (current-status) page: exercised through the real app with the
// demo repository (real seeded incidents, real rules) -- not a UI mock.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';

let App: typeof AppType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  vi.resetModules();
  App = (await import('../App')).default;
});

function main(): HTMLElement {
  return document.querySelector('main') as HTMLElement;
}

// The dashboard link exists in both the desktop sidebar and the mobile
// bottom nav; scope to the sidebar so the query is unambiguous.
async function gotoDashboard(user: ReturnType<typeof userEvent.setup>) {
  const sidebar = document.querySelector('aside') as HTMLElement;
  await user.click(within(sidebar).getByRole('link', { name: /מצב נוכחי/ }));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
}

async function loginAs(userTestId: string) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTestId(userTestId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
  return user;
}

// Seeded incidents relevant to these assertions (see src/data/local/seed.ts):
//   inc-1: critical, in_progress        -> needsAttention
//   inc-2: high,     in_progress        -> openRest, counted in criticalOrHigh
//   inc-5: high,     closed 44h ago
//   inc-6: medium,   closed 60h ago
// Open count across the full seed is 6 (inc-1,2,3,4,7,8).
const INC1_TEXT = /אין יכולת הפעלה מלאה של מערכת אלפא/;
const INC2_TEXT = /עיכוב בקבלת נתונים בעמדת הבקרה/;
const INC3_TEXT = /מערכת גמא עובדת במצב גיבוי/;

describe('top metrics reflect the real seeded data', () => {
  it('shows open / critical-or-high counts grounded in the seed, on two equally interactive KPI cards', async () => {
    await loginAs('login-u-admin');
    const open = within(main()).getByRole('button', { name: /^תקלות פתוחות: 6\./ });
    const criticalHigh = within(main()).getByRole('button', { name: /^קריטיות \/ גבוהות: 2\./ });

    // Both KPI cards are real <button> elements -- equally interactive, not
    // just a single primary one. The former third ("עדכונים באיחור") card
    // was removed along with the next-update-ETA concept -- no replacement.
    for (const btn of [open, criticalHigh]) {
      expect(btn.tagName).toBe('BUTTON');
    }
    expect(screen.queryByRole('button', { name: /עדכונים באיחור/ })).not.toBeInTheDocument();
  });
});

describe('KPI card popups: each opens the shared IncidentListDialog with the correctly filtered list', () => {
  it('"תקלות פתוחות" opens a dialog listing every open incident (6), with an accessible close button', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(within(main()).getByRole('button', { name: /^תקלות פתוחות: 6\./ }));
    const dialog = await screen.findByRole('dialog', { name: 'תקלות פתוחות (6)' });
    const numberLinks = within(dialog)
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.startsWith('/incidents/'));
    expect(numberLinks.length).toBe(6);
    expect(within(dialog).getByRole('button', { name: 'סגירת החלון' })).toBeInTheDocument();
  });

  it('"קריטיות / גבוהות" opens a dialog limited to open critical/high incidents only (1 critical + 1 high, not all 6 open)', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(within(main()).getByRole('button', { name: /^קריטיות \/ גבוהות: 2\./ }));
    const dialog = await screen.findByRole('dialog', { name: 'תקלות קריטיות / גבוהות (2)' });
    const numberLinks = within(dialog)
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.startsWith('/incidents/'));
    expect(numberLinks.length).toBe(2);
    expect(within(dialog).getByText('קריטית')).toBeInTheDocument();
    expect(within(dialog).getByText('גבוהה')).toBeInTheDocument();
  });

  it('only one popup is open at a time, and closing returns to the plain dashboard', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(within(main()).getByRole('button', { name: /^תקלות פתוחות: 6\./ }));
    await screen.findByRole('dialog', { name: 'תקלות פתוחות (6)' });
    await user.click(screen.getByRole('button', { name: 'סגירת החלון' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(within(main()).getByRole('button', { name: /^קריטיות \/ גבוהות: 2\./ }));
    expect(await screen.findByRole('dialog', { name: 'תקלות קריטיות / גבוהות (2)' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'תקלות פתוחות (6)' })).not.toBeInTheDocument();
  });
});

describe('information architecture: urgent, open, recently-closed', () => {
  it('places the critical incident under "דורש טיפול עכשיו" and non-critical open incidents under "תקלות פתוחות"', async () => {
    await loginAs('login-u-admin');
    const urgentHeading = within(main()).getByRole('heading', { name: 'דורש טיפול עכשיו' });
    const urgentSection = urgentHeading.closest('section') as HTMLElement;
    expect(within(urgentSection).getByText(INC1_TEXT)).toBeInTheDocument();

    const openHeading = within(main()).getByRole('heading', { name: 'תקלות פתוחות' });
    const openSection = openHeading.closest('section') as HTMLElement;
    expect(within(openSection).getByText(INC2_TEXT)).toBeInTheDocument();
    expect(within(openSection).getByText(INC3_TEXT)).toBeInTheDocument();
    // The critical incident must not also appear as a second full card here.
    expect(within(openSection).queryByText(INC1_TEXT)).not.toBeInTheDocument();
  });

  it('never renders the same incident as a full card twice on the page', async () => {
    await loginAs('login-u-admin');
    expect(within(main()).getAllByText(INC1_TEXT)).toHaveLength(1);
    expect(within(main()).getAllByText(INC2_TEXT)).toHaveLength(1);
  });

  it('shows a compact recently-closed section with a link back to the full archive', async () => {
    await loginAs('login-u-admin');
    const closedHeading = within(main()).getByRole('heading', { name: 'נסגרו לאחרונה' });
    const closedSection = closedHeading.closest('section') as HTMLElement;
    // inc-5 (closed 44h ago) is more recent than inc-6 (closed 60h ago).
    const links = within(closedSection).getAllByRole('link');
    const numberLinks = links.filter((l) => l.getAttribute('href')?.startsWith('/incidents/'));
    expect(numberLinks.length).toBe(2);
    // The archive link now carries the closed-outcome filter, so it lands on
    // the same set the section and its counter describe rather than on the
    // wider closed-and-cancelled archive.
    expect(within(closedSection).getByRole('link', { name: 'לכל הארכיון' })).toHaveAttribute(
      'href',
      '/archive?outcome=closed',
    );
  });

  it('"נסגרו לאחרונה" includes a cancelled incident alongside closed ones, each with its own status label', async () => {
    // Wraps (not replaces) listIncidents: the dashboard's own real closed
    // fixtures (inc-5/inc-6) must remain present -- only a synthetic
    // cancelled incident, more recent than either, is appended.
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.listIncidents;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'listIncidents')
      .mockImplementation(async function (this: InstanceType<typeof LocalDemoRepository>, ...args) {
        const real = await original.apply(this, args);
        return [
          ...real,
          {
            ...real[0],
            id: 'inc-cancelled-test',
            number: '2026-999',
            status: 'cancelled' as const,
            severity: 'medium' as const,
            closedAt: null,
            closedBy: null,
            cancelledAt: new Date().toISOString(),
            cancelledBy: real[0].createdBy,
            cancellationReason: 'נפתחה בטעות (לבדיקה)',
          },
        ];
      });

    await loginAs('login-u-admin');
    const closedHeading = within(main()).getByRole('heading', { name: 'נסגרו לאחרונה' });
    const closedSection = closedHeading.closest('section') as HTMLElement;
    expect(within(closedSection).getByText('2026-999')).toBeInTheDocument();
    expect(within(closedSection).getByText('בוטלה')).toBeInTheDocument();
    // The two real closed fixtures are unaffected -- three rows total now.
    const links = within(closedSection).getAllByRole('link');
    const numberLinks = links.filter((l) => l.getAttribute('href')?.startsWith('/incidents/'));
    expect(numberLinks.length).toBe(3);

    spy.mockRestore();
  });
});

describe('critical-severity visual marker', () => {
  it('gives the critical incident the critical accent, and a plain open incident none', async () => {
    await loginAs('login-u-admin');
    const criticalCard = within(main()).getByText(INC1_TEXT).closest('a.incident-card') as HTMLElement;
    expect(criticalCard.className).toMatch(/incident-card-accent-critical/);

    const plainCard = within(main()).getByText(INC3_TEXT).closest('a.incident-card') as HTMLElement;
    expect(plainCard.className).not.toMatch(/incident-card-accent/);
  });
});

describe('incident card content and structure', () => {
  it('shows main content (number, severity, description) and metadata (status, handler, last-updated) for a card', async () => {
    await loginAs('login-u-admin');
    const card = within(main()).getByText(INC1_TEXT).closest('a.incident-card') as HTMLElement;
    const cardScope = within(card);
    expect(cardScope.getByText('קריטית')).toBeInTheDocument(); // severity badge
    expect(cardScope.getByText('בטיפול')).toBeInTheDocument(); // status badge (in_progress)
    expect(cardScope.getByText(/עודכן/)).toBeInTheDocument(); // last-updated metadata line
    // Second line: labeled system/location, not scattered elsewhere.
    expect(cardScope.getByText(/מערכת:/)).toBeInTheDocument();
    expect(cardScope.getByText(/מיקום:/)).toBeInTheDocument();
    expect(cardScope.getByText('מערכת אלפא')).toBeInTheDocument();
    expect(cardScope.getByText('אתר 1')).toBeInTheDocument();
  });

  it('the contextual "open" affordance is not the only way to reach the incident -- the whole card is a real link', async () => {
    await loginAs('login-u-admin');
    const card = within(main()).getByText(INC1_TEXT).closest('a.incident-card') as HTMLElement;
    expect(card.tagName).toBe('A');
    expect(card).toHaveAttribute('href', expect.stringContaining('/incidents/'));
    // Reachable by keyboard: a real <a href> is natively focusable/activatable,
    // not dependent on any hover-only affordance.
    expect(card).not.toHaveAttribute('tabindex', '-1');
  });
});

describe('closed-incidents counter beside "נסגרו לאחרונה"', () => {
  // Seed (src/data/local/seed.ts) has exactly two closed incidents
  // (inc-5, inc-6) and no cancelled ones.
  it('shows the total number of closed incidents and links to the closed-only archive', async () => {
    await loginAs('login-u-admin');
    const counter = await within(main()).findByTestId('closed-total');
    expect(counter).toHaveTextContent('2');
    expect(counter).toHaveAttribute('href', '/archive?outcome=closed');
    expect(counter).toHaveAccessibleName('סך הכול 2 תקלות סגורות — מעבר לארכיון');
  });

  it('counts every closed incident, not only the five rendered rows', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    // The list the section renders is capped at five; the count is not
    // derived from it. Nine closed incidents must still read as nine.
    const spy = vi.spyOn(LocalDemoRepository.prototype, 'countClosedIncidents').mockResolvedValue(9);
    try {
      await loginAs('login-u-admin');
      expect(await within(main()).findByTestId('closed-total')).toHaveTextContent('9');
      const closedSection = within(main())
        .getByRole('heading', { name: 'נסגרו לאחרונה' })
        .closest('section') as HTMLElement;
      const rendered = within(closedSection)
        .getAllByRole('link')
        .filter((l) => l.getAttribute('href')?.startsWith('/incidents/'));
      expect(rendered.length).toBeLessThanOrEqual(5);
      expect(rendered.length).not.toBe(9);
    } finally {
      spy.mockRestore();
    }
  });

  it('excludes cancelled incidents even while the section itself lists one', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const original = LocalDemoRepository.prototype.listIncidents;
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'listIncidents')
      .mockImplementation(async function (this: InstanceType<typeof LocalDemoRepository>, ...args) {
        const real = await original.apply(this, args);
        const template = real.find((i) => i.status === 'closed');
        if (!template) return real;
        return [
          ...real,
          {
            ...template,
            id: 'inc-cancelled-synthetic',
            number: '2026-999',
            status: 'cancelled' as const,
            closedAt: null,
            cancelledAt: new Date().toISOString(),
            cancelledBy: 'u-admin',
            cancellationReason: 'נפתחה בטעות',
          },
        ];
      });
    try {
      await loginAs('login-u-admin');
      const closedSection = within(main())
        .getByRole('heading', { name: 'נסגרו לאחרונה' })
        .closest('section') as HTMLElement;
      // The cancelled incident is visible in the section...
      expect(within(closedSection).getByText('בוטלה')).toBeInTheDocument();
      // ...but the counter still reports only the two genuinely closed ones.
      expect(within(main()).getByTestId('closed-total')).toHaveTextContent('2');
    } finally {
      spy.mockRestore();
    }
  });

  it('refreshes after an incident is closed and again after it is reopened', async () => {
    const user = await loginAs('login-u-admin');
    expect(await within(main()).findByTestId('closed-total')).toHaveTextContent('2');

    // --- close inc-1 through the real closure flow ---
    const inc1Card = (await within(main()).findByText(INC1_TEXT)).closest('a.incident-card') as HTMLElement;
    const inc1Href = inc1Card.getAttribute('href') as string;
    await user.click(inc1Card);
    await user.click(await within(main()).findByRole('button', { name: 'סגירת תקלה' }));
    const closeDialog = await screen.findByRole('dialog', { name: 'סגירת תקלה' });
    await user.type(within(closeDialog).getByLabelText(/^סיבת התקלה/), 'תקלת חומרה');
    await user.type(within(closeDialog).getByLabelText(/^הפתרון שבוצע/), 'הוחלף רכיב');
    await user.click(within(closeDialog).getByRole('button', { name: 'המשך לאישור סגירה' }));
    await user.click(await within(closeDialog).findByRole('button', { name: 'אישור סגירת תקלה' }));
    expect(await screen.findByText('התקלה נסגרה.')).toBeInTheDocument();

    await gotoDashboard(user);
    await waitFor(() => expect(within(main()).getByTestId('closed-total')).toHaveTextContent('3'));

    // --- reopen it, and the count must come back down ---
    // It is no longer an open card; it now sits in the recently-closed list,
    // which renders the incident number rather than the description.
    const closedRow = within(main())
      .getAllByRole('link')
      .find((l) => l.getAttribute('href') === inc1Href) as HTMLElement;
    await user.click(closedRow);
    await user.click(await within(main()).findByRole('button', { name: 'פתיחה מחדש' }));
    const reopenDialog = await screen.findByRole('dialog', { name: 'פתיחה מחדש של תקלה' });
    await user.type(within(reopenDialog).getByLabelText(/^סיבת הפתיחה מחדש/), 'התקלה חזרה');
    await user.click(within(reopenDialog).getByRole('button', { name: 'פתיחה מחדש' }));
    expect(await screen.findByText('התקלה נפתחה מחדש.')).toBeInTheDocument();

    await gotoDashboard(user);
    await waitFor(() => expect(within(main()).getByTestId('closed-total')).toHaveTextContent('2'));
  });
});
