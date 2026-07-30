// "מצב נוכחי" (current-status) page: exercised through the real app with the
// demo repository (real seeded incidents, real rules) -- not a UI mock.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

async function loginAs(userTestId: string) {
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByTestId(userTestId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
  return user;
}

// Seeded incidents relevant to these assertions (see src/data/local/seed.ts):
//   inc-1: critical, in_progress, overdue        -> needsAttention
//   inc-2: high,     in_progress, not overdue    -> openRest, counted in criticalOrHigh
//   inc-5: high,     closed 44h ago
//   inc-6: medium,   closed 60h ago
// Open count across the full seed is 6 (inc-1,2,3,4,7,8).
const INC1_TEXT = /אין יכולת הפעלה מלאה של מערכת אלפא/;
const INC2_TEXT = /עיכוב בקבלת נתונים בעמדת הבקרה/;
const INC3_TEXT = /מערכת גמא עובדת במצב גיבוי/;

describe('top metrics reflect the real seeded data', () => {
  it('shows open / critical-or-high / overdue counts grounded in the seed, on three equally interactive KPI cards', async () => {
    await loginAs('login-u-admin');
    const open = within(main()).getByRole('button', { name: /^תקלות פתוחות: 6\./ });
    const criticalHigh = within(main()).getByRole('button', { name: /^קריטיות \/ גבוהות: 2\./ });
    const overdue = within(main()).getByRole('button', { name: /^עדכונים באיחור: 1\./ });

    // All three KPI cards are real <button> elements -- equally interactive,
    // not just a single primary one.
    for (const btn of [open, criticalHigh, overdue]) {
      expect(btn.tagName).toBe('BUTTON');
    }
    expect(overdue).toHaveClass('border-yellow-300', 'dark:border-yellow-700');
    expect(overdue).not.toHaveClass('border-orange-200', 'dark:border-orange-800');
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

  it('"עדכונים באיחור" opens a dialog limited to incidents currently overdue for an update (1, not all 6 open)', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(within(main()).getByRole('button', { name: /^עדכונים באיחור: 1\./ }));
    const dialog = await screen.findByRole('dialog', { name: 'עדכונים באיחור (1)' });
    const numberLinks = within(dialog)
      .getAllByRole('link')
      .filter((l) => l.getAttribute('href')?.startsWith('/incidents/'));
    expect(numberLinks.length).toBe(1);
  });

  it('only one popup is open at a time, and closing returns to the plain dashboard', async () => {
    const user = await loginAs('login-u-admin');
    await user.click(within(main()).getByRole('button', { name: /^תקלות פתוחות: 6\./ }));
    await screen.findByRole('dialog', { name: 'תקלות פתוחות (6)' });
    await user.click(screen.getByRole('button', { name: 'סגירת החלון' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(within(main()).getByRole('button', { name: /^עדכונים באיחור: 1\./ }));
    expect(await screen.findByRole('dialog', { name: 'עדכונים באיחור (1)' })).toBeInTheDocument();
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
    expect(within(closedSection).getByRole('link', { name: 'לכל הארכיון' })).toHaveAttribute('href', '/archive');
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
  it('gives the critical+overdue incident the critical accent (red takes precedence), and a plain open incident none', async () => {
    await loginAs('login-u-admin');
    // inc-1 is both critical and overdue -- the critical (red) treatment must win.
    const criticalCard = within(main()).getByText(INC1_TEXT).closest('a.incident-card') as HTMLElement;
    expect(criticalCard.className).toMatch(/incident-card-accent-critical/);
    expect(criticalCard.className).not.toMatch(/incident-card-accent-overdue/);

    const plainCard = within(main()).getByText(INC3_TEXT).closest('a.incident-card') as HTMLElement;
    expect(plainCard.className).not.toMatch(/incident-card-accent/);
  });
});

describe('incident card content and structure', () => {
  it('shows main content (number, severity, description, next-update state) and metadata (status, handler, last-updated) for a card', async () => {
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
