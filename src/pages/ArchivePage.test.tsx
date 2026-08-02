// Archive scope: closed AND cancelled incidents (terminalOnly), never open
// ones. A cancelled incident must have a real place to be found after it
// leaves the open-incident views -- exercised through the real app with the
// demo repository, mirroring IncidentDetailPage.test.tsx's approach.
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

async function goToAdmin(user: ReturnType<typeof userEvent.setup>) {
  const sidebarNav = screen.getByRole('navigation', { name: 'ניווט ראשי' });
  await user.click(within(sidebarNav).getByRole('link', { name: 'ניהול' }));
  await within(main()).findByRole('heading', { name: 'ניהול' });
}

// מערכת בטא (sys-beta) already has a closed archive incident (inc-5).
// Deactivating it through the real admin flow gives a genuine, live
// "archived system with historical archive incidents" fixture, instead of
// hand-editing the shared demo seed (which several other pages' tests
// assert exact counts against).
async function deactivateSystemBeta(user: ReturnType<typeof userEvent.setup>) {
  await goToAdmin(user);
  const row = (await within(main()).findByText('מערכת בטא')).closest('article') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: 'השבתה' }));
  const dialog = await screen.findByRole('dialog', { name: 'השבתת מערכת / עמדה' });
  await user.click(within(dialog).getByRole('button', { name: 'השבתה' }));
  await screen.findByText('המצב עודכן בהצלחה.');
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

describe('Archive: system filter (replaces the removed כשירות בסגירה filter)', () => {
  it('כשירות בסגירה no longer appears, and כל המערכות is the system filter\'s default option', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    expect(within(main()).queryByLabelText('סינון לפי כשירות בסגירה')).not.toBeInTheDocument();
    expect(within(main()).queryByText(/כשירות בסגירה/)).not.toBeInTheDocument();

    const systemSelect = within(main()).getByLabelText('סינון לפי מערכת');
    expect(systemSelect).toHaveValue('');
    expect(within(systemSelect).getByRole('option', { name: 'כל המערכות' })).toBeInTheDocument();
  });

  it('selecting a system filters the archived list and stores the selection in the URL', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument(); // sys-beta
    expect(within(main()).getByText(INC9_TEXT)).toBeInTheDocument(); // sys-alpha

    await user.selectOptions(within(main()).getByLabelText('סינון לפי מערכת'), 'sys-beta');

    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC9_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('system')).toBe('sys-beta');
  });

  it('a deep link / refresh with ?system= restores the selected system and the filtered result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));

    // Simulates a refresh/deep link landing straight on the filtered URL --
    // a second render, mirroring the same pattern used for the equivalent
    // check elsewhere in this codebase (e.g. ReportsPage.test.tsx). Query
    // through plain `screen`, not the `main()` helper: the first render's
    // tree is still mounted alongside this one, so `main()` (which grabs
    // the first <main> in the document) would return the stale, pre-
    // navigation tree instead of this fresh one.
    window.history.pushState({}, '', '/archive?system=sys-beta');
    render(<App />);
    await screen.findByRole('heading', { name: /ארכיון/ });

    expect(screen.getByLabelText('סינון לפי מערכת')).toHaveValue('sys-beta');
    expect(await screen.findByText(INC5_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(INC9_TEXT)).not.toBeInTheDocument();
  });

  it('reset removes the system parameter and restores the unfiltered archive result', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    await user.selectOptions(within(main()).getByLabelText('סינון לפי מערכת'), 'sys-beta');
    expect(new URLSearchParams(window.location.search).get('system')).toBe('sys-beta');

    await user.selectOptions(within(main()).getByLabelText('סינון לפי מערכת'), '');

    expect(new URLSearchParams(window.location.search).has('system')).toBe(false);
    expect(within(main()).getByLabelText('סינון לפי מערכת')).toHaveValue('');
    expect(await within(main()).findByText(INC9_TEXT)).toBeInTheDocument();
  });

  it('an archived system associated with a historical archive incident remains selectable and filterable', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));

    await deactivateSystemBeta(user);
    await goToArchive(user);

    const systemSelect = within(main()).getByLabelText('סינון לפי מערכת');
    // Still listed -- and visually marked as archived -- rather than
    // silently dropped from the filter now that it's inactive.
    expect(within(systemSelect).getByRole('option', { name: 'מערכת בטא (בארכיון)' })).toBeInTheDocument();

    await user.selectOptions(systemSelect, 'sys-beta');
    expect(await within(main()).findByText(INC5_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC9_TEXT)).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get('system')).toBe('sys-beta');
  });

  it('composes correctly with the date filter, status filter and general search', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-admin'));
    await goToArchive(user);

    await user.selectOptions(within(main()).getByLabelText('סינון לפי תוצאה'), 'closed');
    await user.selectOptions(within(main()).getByLabelText('סינון לפי מערכת'), 'sys-beta');
    await user.type(within(main()).getByLabelText('חיפוש בארכיון'), 'תצורה');

    // The search field commits to the URL only after a debounce (see
    // useDebouncedField) -- inc-5 already matches on outcome+system alone,
    // so waiting for it to render isn't proof the search term has committed
    // yet. Wait for the 'q' param itself before asserting on it.
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('q')).toBe('תצורה'));

    expect(within(main()).getByText(INC5_TEXT)).toBeInTheDocument();
    expect(within(main()).queryByText(INC9_TEXT)).not.toBeInTheDocument();

    const params = new URLSearchParams(window.location.search);
    expect(params.get('outcome')).toBe('closed');
    expect(params.get('system')).toBe('sys-beta');
  });
});
