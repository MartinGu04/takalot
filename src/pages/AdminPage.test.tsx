import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';
import type { AppError as AppErrorType } from '../data/repository';

// App.tsx holds its React Query cache (and the demo repository) in
// module-level singletons shared across every render within one imported
// module instance. Several tests below re-render the app against the same
// entity types (systems/locations); without a fresh module (and therefore a
// fresh cache and a freshly re-seeded demo repository) per test, a later
// test could see a stale cache hit or leftover mutations from an earlier
// one. Resetting modules and re-importing per test gives each test its own
// QueryClient and repository, exactly as a real page load would.
let App: typeof AppType;
let hooks: typeof import('../data/hooks');
let AppError: typeof AppErrorType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  vi.resetModules();
  App = (await import('../App')).default;
  hooks = await import('../data/hooks');
  AppError = (await import('../data/repository')).AppError;
});

/** A compact row card no longer uses a heading for the record name (only
 *  the category section uses <h2>) -- find it by its visible name text. */
function cardNamed(name: string): HTMLElement {
  const text = screen.getByText(name, { selector: 'p' });
  const card = text.closest('article');
  if (!card) throw new Error(`No management card found for ${name}`);
  return card;
}

/** The <section> for one fixed category, found by its <h2> heading (which
 *  always renders as "<label> (<count>)"). */
function categorySection(labelPrefix: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: new RegExp(`^${labelPrefix} \\(\\d+\\)$`) });
  const section = heading.closest('section');
  if (!section) throw new Error(`No category section found for ${labelPrefix}`);
  return section;
}

async function openActionMenu(user: ReturnType<typeof userEvent.setup>, recordName: string): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: `פעולות עבור ${recordName}` }));
  return screen.getByRole('menu', { name: `פעולות עבור ${recordName}` });
}

async function loginAdminAndOpenManagement(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId('login-u-admin'));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
  await user.click(screen.getAllByRole('link', { name: 'ניהול' })[0]);
  await screen.findByRole('heading', { name: 'ניהול' });
}

/**
 * dnd-kit's collision detection and keyboard coordinate getter both compare
 * sortable items' getBoundingClientRect().top -- jsdom never lays anything
 * out (every rect is 0x0 at the origin), so without this every item looks
 * identical and neither pointer nor keyboard movement can pick a direction.
 * Stubbing article rects by DOM order (within their own parent, i.e. their
 * own category's list) gives dnd-kit the same "row N is below row N-1"
 * signal a real browser's layout would produce.
 */
function stubSortableRowRects() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === 'ARTICLE') {
      const siblings = Array.from(this.parentElement?.children ?? []);
      const index = siblings.indexOf(this);
      const top = index * 88;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 400,
        bottom: top + 80,
        width: 400,
        height: 80,
        toJSON: () => ({}),
      } as DOMRect;
    }
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  });
}

/** DOM order of the record names WITHIN one category section. */
function categoryRecordOrder(labelPrefix: string): string[] {
  const section = categorySection(labelPrefix);
  return Array.from(section.querySelectorAll('article p.truncate')).map((p) => p.textContent ?? '');
}

describe('reference-data management UI', () => {
  it('renders the five fixed category sections in order, with a compact empty state for empty ones', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);

    // Systems tab: fixed order, exact Hebrew labels, with live counts.
    // Seed: sys-alpha=platforms(1), sys-beta+sys-pos-a=station_systems(2),
    // sys-gamma=computing(1), sys-pos-b=infrastructure(1), none in 'other'.
    const systemHeadings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(systemHeadings).toEqual([
      'פלטפורמות (1)',
      'מערכות תחנה (2)',
      'מחשוב (1)',
      'תשתיות (1)',
      'אחר (0)',
    ]);
    expect(categorySection('אחר')).toHaveTextContent('אין פריטים בקטגוריה זו');
    expect(categoryRecordOrder('פלטפורמות')).toEqual(['מערכת אלפא']);
    expect(categoryRecordOrder('מערכות תחנה')).toEqual(['מערכת בטא', 'עמדה א׳']);

    await user.click(screen.getByRole('tab', { name: 'מיקומים' }));
    // loc-1+loc-control=unit_internal(2), loc-2=field_side(1), loc-3=external_bases(1).
    const locationHeadings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(locationHeadings).toEqual([
      'פנים יחידתי (2)',
      'צד שטח (1)',
      'בסיסים חיצוניים (1)',
      'אתרים חיצוניים (0)',
      'אחר (0)',
    ]);
    expect(categoryRecordOrder('פנים יחידתי')).toEqual(['אתר 1', 'חדר בקרה ראשי']);
  });

  it('supports the complete accessible system workflow via the three-dot menu, in RTL', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);

    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('tab', { name: 'מערכות / עמדות' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'מיקומים' })).toHaveAttribute('aria-selected', 'false');

    const systemName = 'מערכת בדיקת ניהול';
    await user.type(screen.getByLabelText(/^שם מערכת \/ עמדה חדשה/), `  ${systemName}  `);
    // Creation requires an explicit category selection -- the fixed-order
    // <select> defaults to the first category (פלטפורמות); switch to
    // "מחשוב" to prove the chosen category, not just the default, is used.
    await user.selectOptions(screen.getByLabelText(/^סוג /), 'computing');
    await user.click(screen.getByRole('button', { name: 'הוספה' }));
    await screen.findByText(systemName, { selector: 'p' });
    expect(await screen.findByText('המערכת / העמדה נוספה בהצלחה.')).toBeInTheDocument();

    // Appended to the end of the selected category (מחשוב already had
    // מערכת גמא as its sole member).
    expect(categoryRecordOrder('מחשוב')).toEqual(['מערכת גמא', systemName]);

    let systemCard = cardNamed(systemName);
    expect(within(systemCard).getByText('פעיל')).toBeInTheDocument();
    const dragHandle = within(systemCard).getByRole('button', {
      name: `גרירה לשינוי סדר עבור ${systemName}`,
    });
    expect(dragHandle).toHaveAttribute('aria-roledescription', 'sortable');
    expect(dragHandle).not.toBeDisabled();
    // No permanent bordered box / background around the handle itself --
    // only the grip icon and a transparent, generously sized hit target.
    expect(dragHandle.className).not.toMatch(/\bborder\b/);
    expect(dragHandle.className).not.toMatch(/\bbg-(surface|white|black)\b/);

    // The old always-visible rename/deactivate/delete button row is gone --
    // every per-record action lives behind the three-dot menu now.
    expect(within(systemCard).queryByRole('button', { name: 'שינוי שם' })).not.toBeInTheDocument();
    expect(within(systemCard).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    expect(within(systemCard).queryByRole('button', { name: `מחיקת ${systemName}` })).not.toBeInTheDocument();
    const menuTrigger = within(systemCard).getByRole('button', { name: `פעולות עבור ${systemName}` });
    expect(menuTrigger).toHaveAttribute('aria-haspopup', 'menu');

    let menu = await openActionMenu(user, systemName);
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'שינוי שם',
      'שינוי סוג',
      'השבתה',
      'מחיקה',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'שינוי שם' }));

    const renameDialog = screen.getByRole('dialog', { name: 'שינוי שם מערכת / עמדה' });
    const renameInput = within(renameDialog).getByLabelText(/^שם חדש/);
    await user.clear(renameInput);
    await user.type(renameInput, 'מערכת לאחר שינוי');
    await user.click(within(renameDialog).getByRole('button', { name: 'שמירת השם' }));
    await screen.findByText('מערכת לאחר שינוי', { selector: 'p' });

    systemCard = cardNamed('מערכת לאחר שינוי');
    menu = await openActionMenu(user, 'מערכת לאחר שינוי');
    await user.click(within(menu).getByRole('menuitem', { name: 'השבתה' }));
    const deactivateDialog = screen.getByRole('dialog', { name: 'השבתת מערכת / עמדה' });
    expect(deactivateDialog).toHaveTextContent('לא תופיע בבחירה בעת פתיחת תקלה חדשה');
    await user.click(within(deactivateDialog).getByRole('button', { name: 'השבתה' }));
    systemCard = cardNamed('מערכת לאחר שינוי');
    await within(systemCard).findByText('לא פעיל');

    // Inactive records show "הפעלה מחדש" instead of "השבתה".
    menu = await openActionMenu(user, 'מערכת לאחר שינוי');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'שינוי שם',
      'שינוי סוג',
      'הפעלה מחדש',
      'מחיקה',
    ]);
    await user.click(within(menu).getByRole('menuitem', { name: 'הפעלה מחדש' }));
    systemCard = cardNamed('מערכת לאחר שינוי');
    await within(systemCard).findByText('פעיל');

    menu = await openActionMenu(user, 'מערכת לאחר שינוי');
    await user.click(within(menu).getByRole('menuitem', { name: 'מחיקה' }));
    const deleteDialog = screen.getByRole('dialog', { name: 'מחיקת מערכת / עמדה' });
    expect(deleteDialog).toHaveTextContent('פריט שמקושר לתקלה או לרשומה היסטורית יישמר');
    await user.click(within(deleteDialog).getByRole('button', { name: 'בקשת מחיקה' }));
    expect(await screen.findByText(/נמחקה לצמיתות משום שלא הייתה בשימוש/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('מערכת לאחר שינוי', { selector: 'p' })).not.toBeInTheDocument(),
    );
  });

  it('changes a system\'s category via "שינוי סוג", moving it to the destination section', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);

    expect(categoryRecordOrder('פלטפורמות')).toEqual(['מערכת אלפא']);
    expect(categoryRecordOrder('תשתיות')).toEqual(['עמדה ב׳']);

    const menu = await openActionMenu(user, 'מערכת אלפא');
    await user.click(within(menu).getByRole('menuitem', { name: 'שינוי סוג' }));
    const dialog = await screen.findByRole('dialog', { name: 'שינוי סוג עבור מערכת אלפא' });
    expect(dialog).toHaveTextContent('פלטפורמות'); // current category shown
    // The current category is never offered as a selectable destination.
    expect(within(dialog).queryByRole('option', { name: 'פלטפורמות' })).not.toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText(/^סוג חדש/), 'תשתיות');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));
    await screen.findByText('הסוג עודכן בהצלחה.');

    await waitFor(() => {
      expect(categoryRecordOrder('פלטפורמות')).toEqual([]);
      // Appended to the END of the destination category.
      expect(categoryRecordOrder('תשתיות')).toEqual(['עמדה ב׳', 'מערכת אלפא']);
    });
    expect(categorySection('פלטפורמות')).toHaveTextContent('אין פריטים בקטגוריה זו');

    // Active/inactive state survives the category change: עמדה ב׳ was
    // seeded archived, and stays so after this unrelated move.
    expect(within(cardNamed('עמדה ב׳')).getByText('לא פעיל')).toBeInTheDocument();
    expect(within(cardNamed('מערכת אלפא')).getByText('פעיל')).toBeInTheDocument();
  });

  it('keeps global search results grouped by category rather than flattening them', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);

    await user.type(screen.getByLabelText('חיפוש במערכות / עמדות'), 'עמדה');
    // Matches sys-pos-a ("עמדה א׳", station_systems) and sys-pos-b
    // ("עמדה ב׳", infrastructure) -- still two separate category sections,
    // not one flat list.
    await waitFor(() => {
      expect(categoryRecordOrder('מערכות תחנה')).toEqual(['עמדה א׳']);
    });
    expect(categoryRecordOrder('תשתיות')).toEqual(['עמדה ב׳']);
    expect(categorySection('פלטפורמות')).toHaveTextContent('אין תוצאות התואמות לחיפוש בקטגוריה זו');
    expect(screen.queryByText('מערכת אלפא')).not.toBeInTheDocument();

    // Dragging is disabled while a search is active (a partial, filtered
    // list is not a meaningful reorder target).
    expect(
      screen.queryByRole('button', { name: 'גרירה לשינוי סדר עבור עמדה א׳' }),
    ).not.toBeInTheDocument();
  });

  it('shows a controlled conflict instead of creating a normalized duplicate', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);

    await user.type(screen.getByLabelText(/^שם מערכת \/ עמדה חדשה/), '  מערכת אלפא  ');
    await user.click(screen.getByRole('button', { name: 'הוספה' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('כבר קיימת מערכת / עמדה בשם זה');
    expect(alert).toHaveTextContent('להפעיל מחדש');
  });
});

describe('drag-and-drop reordering', () => {
  it('reorders locations within one category via the keyboard-focused drag handle, leaves other categories untouched, and keeps the order after a refresh', async () => {
    stubSortableRowRects();
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await loginAdminAndOpenManagement(user);
    await user.click(screen.getByRole('tab', { name: 'מיקומים' }));
    await screen.findByText('אתר 1', { selector: 'p' });

    // unit_internal has exactly two members: אתר 1, then חדר בקרה ראשי.
    expect(categoryRecordOrder('פנים יחידתי')).toEqual(['אתר 1', 'חדר בקרה ראשי']);
    // צד שטח (field_side, אתר 2) and בסיסים חיצוניים (external_bases, אתר 3)
    // are separate, unrelated categories/sections.
    expect(categoryRecordOrder('צד שטח')).toEqual(['אתר 2']);
    expect(categoryRecordOrder('בסיסים חיצוניים')).toEqual(['אתר 3']);

    const handle = screen.getByRole('button', { name: 'גרירה לשינוי סדר עבור אתר 1' });
    handle.focus();
    await user.keyboard(' '); // pick up
    await user.keyboard('{ArrowDown}'); // move one position down, within its own category
    await user.keyboard(' '); // drop

    await waitFor(() => {
      expect(categoryRecordOrder('פנים יחידתי')).toEqual(['חדר בקרה ראשי', 'אתר 1']);
    });
    // Cross-category dragging cannot happen through the UI (each category is
    // its own SortableContext) -- the other two, unrelated sections are
    // provably unaffected by this drag.
    expect(categoryRecordOrder('צד שטח')).toEqual(['אתר 2']);
    expect(categoryRecordOrder('בסיסים חיצוניים')).toEqual(['אתר 3']);

    // Simulate a refresh: unmount the whole app tree and remount against the
    // same underlying (localStorage-backed) demo database. The demo session
    // itself is also persisted, so the remounted app lands directly back on
    // the already-authenticated admin screen without logging in again.
    unmount();
    render(<App />);
    await screen.findByRole('heading', { name: 'ניהול' });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'מיקומים' }));
    await screen.findByText('אתר 1', { selector: 'p' });
    expect(categoryRecordOrder('פנים יחידתי')).toEqual(['חדר בקרה ראשי', 'אתר 1']);
  });

  it('restores the previous order and shows a Hebrew error toast when persistence fails', async () => {
    stubSortableRowRects();
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);
    await user.click(screen.getByRole('tab', { name: 'מיקומים' }));
    await screen.findByText('אתר 1', { selector: 'p' });
    expect(categoryRecordOrder('פנים יחידתי')).toEqual(['אתר 1', 'חדר בקרה ראשי']);

    const failure = new AppError('NETWORK', 'אירעה שגיאה בלתי צפויה מול השרת. הנתונים לא נשמרו — ניתן לנסות שוב.');
    const reorderSpy = vi.spyOn(hooks.repo(), 'reorderLocations').mockRejectedValueOnce(failure);

    const handle = screen.getByRole('button', { name: 'גרירה לשינוי סדר עבור אתר 1' });
    handle.focus();
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    await user.keyboard(' ');

    // The optimistic reorder is applied immediately on drop and then
    // reverted to the exact previous order once the backend rejects it.
    await screen.findByText(failure.message);
    await waitFor(() => {
      expect(categoryRecordOrder('פנים יחידתי')).toEqual(['אתר 1', 'חדר בקרה ראשי']);
    });
    expect(reorderSpy).toHaveBeenCalledTimes(1);
    // Only that one category's ids were submitted -- never the whole table.
    expect(reorderSpy.mock.calls[0][1]).toEqual(
      expect.arrayContaining([expect.any(String), expect.any(String)]),
    );
    expect(reorderSpy.mock.calls[0][1]).toHaveLength(2);

    // The row's existing actions remain fully functional after a failed drag.
    const menu = await openActionMenu(user, 'אתר 1');
    await user.click(within(menu).getByRole('menuitem', { name: 'שינוי שם' }));
    expect(screen.getByRole('dialog', { name: 'שינוי שם מיקום' })).toBeInTheDocument();
  });

  it('does not offer the drag handle or the actions menu to a role without reference-data permission', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-viewer'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    expect(screen.queryAllByRole('link', { name: 'ניהול' })).toHaveLength(0);

    window.history.pushState({}, '', '/admin');
    render(<App />);
    expect(screen.queryByRole('button', { name: /^גרירה לשינוי סדר/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^פעולות עבור/ })).not.toBeInTheDocument();
  });
});
