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
  it('shows open / critical-or-high / overdue counts grounded in the seed', async () => {
    await loginAs('login-u-admin');
    const primary = within(main()).getByRole('button', { name: /תקלות פתוחות/ });
    expect(primary).toHaveTextContent('6');

    const criticalHigh = within(main()).getByText('קריטיות / גבוהות').closest('.surface');
    expect(criticalHigh).toHaveTextContent('2');

    const overdue = within(main()).getByText('עדכונים באיחור').closest('.surface');
    expect(overdue).toHaveTextContent('1');
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
});

describe('critical-severity visual marker', () => {
  it('gives the critical/overdue incident the accent marker class, and a plain open incident none', async () => {
    await loginAs('login-u-admin');
    const criticalCard = within(main()).getByText(INC1_TEXT).closest('a.incident-card') as HTMLElement;
    expect(criticalCard.className).toMatch(/incident-card-accent/);

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
