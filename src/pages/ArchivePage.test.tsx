// Archive scope: closed AND cancelled incidents (terminalOnly), never open
// ones. A cancelled incident must have a real place to be found after it
// leaves the open-incident views -- exercised through the real app with the
// demo repository, mirroring IncidentDetailPage.test.tsx's approach.
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

const INC1_TEXT = /אין יכולת הפעלה מלאה של מערכת אלפא/; // inc-1: open (in_progress)
const INC2_TEXT = /עיכוב בקבלת נתונים בעמדת הבקרה/; // inc-2: open (in_progress)
const INC5_TEXT = /מערכת בטא הושבתה לחלוטין למשך הטיפול/; // inc-5: seeded closed, createdOffset -50h
const INC9_TEXT = /לא הייתה פגיעה תפקודית מתמשכת/; // inc-9: seeded closed, createdOffset -500h (rendered impact text)

async function goToArchive(user: ReturnType<typeof userEvent.setup>) {
  const sidebarNav = screen.getByRole('navigation', { name: 'ניווט ראשי' });
  await user.click(within(sidebarNav).getByRole('link', { name: 'ארכיון' }));
  // ArchivePage is lazy-loaded (React.lazy in App.tsx): without this, a
  // findByText for incident content can match a stale, still-hidden node
  // from the previous page before the new one finishes mounting.
  await within(main()).findByRole('heading', { name: /ארכיון/ });
}

async function cancelIncidentOneAsAdmin(user: ReturnType<typeof userEvent.setup>) {
  const card = await within(main()).findByText(INC1_TEXT);
  await user.click(card.closest('a.incident-card') as HTMLElement);
  await user.click(await within(main()).findByRole('button', { name: 'פעולות נוספות' }));
  const menu = await screen.findByRole('menu', { name: 'פעולות נוספות לתקלה' });
  await user.click(within(menu).getByRole('menuitem', { name: 'ביטול תקלה' }));
  const dialog = await screen.findByRole('dialog', { name: 'ביטול תקלה' });
  await user.type(within(dialog).getByLabelText(/^סיבת הביטול/), 'נפתחה בטעות על ידי המפעיל');
  await user.click(within(dialog).getByRole('button', { name: 'בטל תקלה' }));
  await screen.findByText('התקלה בוטלה.');
}

describe('Archive: terminal incidents only', () => {
  it('shows a closed incident normally, and never shows an open incident', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC1_TEXT)).not.toBeInTheDocument();
    expect(within(main()).queryByText(INC2_TEXT)).not.toBeInTheDocument();
  });

  it('a freshly cancelled incident appears in the archive labelled בוטלה, distinguishable from a closed incident labelled נסגרה, and opens into its own detail page with the cancellation preserved', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));

    // Cancel inc-1 through the real cancellation flow (UI -> repository -> RPC).
    await cancelIncidentOneAsAdmin(user);

    await goToArchive(user);

    const cancelledCard = (await within(main()).findByText(INC1_TEXT)).closest('a.incident-card') as HTMLElement;
    expect(within(cancelledCard).getByText('בוטלה')).toBeInTheDocument();
    expect(within(cancelledCard).queryByText('נסגרה')).not.toBeInTheDocument();

    const closedCard = (await within(main()).findByText(INC5_TEXT)).closest('a.incident-card') as HTMLElement;
    expect(within(closedCard).getByText('נסגרה')).toBeInTheDocument();
    expect(within(closedCard).queryByText('בוטלה')).not.toBeInTheDocument();

    // The cancelled incident's archive card opens into its OWN detail page --
    // not a mislinked or generic one -- with its cancellation timeline intact.
    // Wait for the timeline heading first (unique to the detail page, unlike
    // the incident's operational-impact text, which the stale, still-
    // unmounting archive card also contains during the lazy-loaded transition).
    await user.click(cancelledCard);
    const timeline = (await within(main()).findByText('ציר זמן')).closest('section') as HTMLElement;
    expect(within(main()).getByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).getAllByText('בוטלה').length).toBeGreaterThan(0);
    expect(within(timeline).getByText('נפתחה בטעות על ידי המפעיל')).toBeInTheDocument();
  });
});

describe('Archive: closed-only navigation from the dashboard counter', () => {
  it('clicking the closed counter lands on an archive showing closed incidents and no cancelled ones', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));

    // Give the archive a cancelled incident to exclude.
    await cancelIncidentOneAsAdmin(user);
    const sidebar = document.querySelector('aside') as HTMLElement;
    await user.click(within(sidebar).getByRole('link', { name: /מצב נוכחי/ }));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    await user.click(await within(main()).findByTestId('closed-total'));
    await within(main()).findByRole('heading', { name: /ארכיון/ });

    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC1_TEXT)).not.toBeInTheDocument();
    expect(within(main()).queryByText('בוטלה')).not.toBeInTheDocument();
    // The filter is visible and reversible, not an invisible URL-only state.
    expect(within(main()).getByLabelText('סינון לפי תוצאה')).toHaveValue('closed');
  });

  it('"לכל הארכיון" lands on the same closed-only view, and clearing the filter restores both outcomes', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await cancelIncidentOneAsAdmin(user);
    const sidebar = document.querySelector('aside') as HTMLElement;
    await user.click(within(sidebar).getByRole('link', { name: /מצב נוכחי/ }));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    await user.click(within(main()).getByRole('link', { name: 'לכל הארכיון' }));
    await within(main()).findByRole('heading', { name: /ארכיון/ });
    expect(within(main()).queryByText(INC1_TEXT)).not.toBeInTheDocument();

    await user.selectOptions(within(main()).getByLabelText('סינון לפי תוצאה'), '');
    expect(await within(main()).findByText(INC1_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC5_TEXT)).toBeInTheDocument();
  });
});

describe('Archive: date-range filter control', () => {
  function toDateInputValue(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // inc-5 was created ~50h ago and inc-9 ~500h ago (see seed.ts createdOffset
  // values) -- a 3-day (72h) window comfortably includes the former and
  // excludes the latter regardless of the exact time of day the test runs.
  const today = toDateInputValue(new Date());
  const threeDaysAgo = toDateInputValue(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));

  it('the date inputs are not permanently visible; a single "סינון לפי תאריך" button replaces them', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    expect(within(main()).queryByLabelText('מתאריך')).not.toBeInTheDocument();
    expect(within(main()).queryByLabelText('עד תאריך')).not.toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: 'סינון לפי תאריך' })).toBeInTheDocument();
  });

  it('opening the date-filter control reveals both date fields', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    await user.click(within(main()).getByRole('button', { name: 'סינון לפי תאריך' }));
    expect(screen.getByLabelText('מתאריך')).toBeInTheDocument();
    expect(screen.getByLabelText('עד תאריך')).toBeInTheDocument();
  });

  it('applying a valid range narrows the archive and updates the URL, and reopening shows the applied dates', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument();
    expect(within(main()).getByText(INC9_TEXT)).toBeInTheDocument();

    await user.click(within(main()).getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), threeDaysAgo);
    await user.type(screen.getByLabelText('עד תאריך'), today);
    await user.click(screen.getByRole('button', { name: 'החל סינון' }));

    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC9_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('from')).toBe(threeDaysAgo);
    expect(new URLSearchParams(window.location.search).get('to')).toBe(today);

    // Reopening shows the currently applied values, not a blank draft.
    await user.click(
      within(main()).getByRole('button', { name: /^\d{2}\.\d{2}\.\d{4}–\d{2}\.\d{2}\.\d{4}$/ }),
    );
    expect(screen.getByLabelText('מתאריך')).toHaveValue(threeDaysAgo);
    expect(screen.getByLabelText('עד תאריך')).toHaveValue(today);
  });

  it('clearing removes both date values and restores the unfiltered archive result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    await user.click(within(main()).getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), threeDaysAgo);
    await user.click(screen.getByRole('button', { name: 'החל סינון' }));
    expect(within(main()).queryByText(INC9_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has('from')).toBe(true);

    await user.click(within(main()).getByRole('button', { name: /^מתאריך/ }));
    await user.click(screen.getByRole('button', { name: 'נקה' }));

    expect(await within(main()).findByText(INC9_TEXT)).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).has('from')).toBe(false);
    expect(new URLSearchParams(window.location.search).has('to')).toBe(false);
  });

  it('an invalid reversed range is rejected clearly and does not change the archive results or URL', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    await user.click(within(main()).getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), today);
    await user.type(screen.getByLabelText('עד תאריך'), threeDaysAgo);
    await user.click(screen.getByRole('button', { name: 'החל סינון' }));

    expect(screen.getByRole('alert')).toHaveTextContent('תאריך ההתחלה חייב להיות מוקדם מתאריך הסיום');
    expect(new URLSearchParams(window.location.search).has('from')).toBe(false);
    expect(within(main()).getByText(INC9_TEXT)).toBeInTheDocument();
  });

  it('closing the panel without applying leaves the archive and URL unchanged', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    await user.click(within(main()).getByRole('button', { name: 'סינון לפי תאריך' }));
    await user.type(screen.getByLabelText('מתאריך'), threeDaysAgo);
    await user.keyboard('{Escape}');

    expect(new URLSearchParams(window.location.search).has('from')).toBe(false);
    expect(within(main()).getByRole('button', { name: 'סינון לפי תאריך' })).toBeInTheDocument();
    expect(within(main()).getByText(INC9_TEXT)).toBeInTheDocument();
  });

  it('the existing search and status filters still work alongside the date-filter control', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    await user.selectOptions(within(main()).getByLabelText('סינון לפי תוצאה'), 'closed');
    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument();

    await user.type(within(main()).getByLabelText('חיפוש בארכיון'), 'בטא');
    await within(main()).findByText('1 תקלות בארכיון תואמות');
    expect(within(main()).getByText(INC5_TEXT)).toBeInTheDocument();
  });
});
