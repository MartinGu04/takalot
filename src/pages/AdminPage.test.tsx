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

function cardNamed(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name });
  const card = heading.closest('article');
  if (!card) throw new Error(`No management card found for ${name}`);
  return card;
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
 * Stubbing article rects by DOM order gives dnd-kit the same "row N is
 * below row N-1" signal a real browser's layout would produce.
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

/** DOM order of the currently rendered config cards' names (h2 headings). */
function currentRecordOrder(): string[] {
  return screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent ?? '');
}

describe('reference-data management UI', () => {
  it('supports the complete accessible system and location workflow in RTL', async () => {
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);

    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('tab', { name: 'מערכות / עמדות' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'מיקומים' })).toHaveAttribute('aria-selected', 'false');

    const systemName = 'מערכת בדיקת ניהול';
    await user.type(screen.getByLabelText(/^שם מערכת \/ עמדה חדשה/), `  ${systemName}  `);
    await user.click(screen.getByRole('button', { name: 'הוספה' }));
    await screen.findByRole('heading', { name: systemName });
    expect(await screen.findByText('המערכת / העמדה נוספה בהצלחה.')).toBeInTheDocument();

    let systemCard = cardNamed(systemName);
    expect(within(systemCard).getByText('פעיל')).toBeInTheDocument();
    expect(within(systemCard).getByText(/סדר תצוגה:/)).toBeInTheDocument();
    const dragHandle = within(systemCard).getByRole('button', {
      name: `גרירה לשינוי סדר עבור ${systemName}`,
    });
    expect(dragHandle).toHaveTextContent('⠿');
    expect(dragHandle).toHaveAttribute('aria-roledescription', 'sortable');
    expect(dragHandle).not.toBeDisabled();

    const betaCard = cardNamed('מערכת בטא');
    expect(
      within(betaCard).getByRole('button', { name: 'גרירה לשינוי סדר עבור מערכת בטא' }),
    ).toBeInTheDocument();

    // The old "שינוי סדר" up/down menu is fully replaced by the drag handle.
    expect(screen.queryByRole('button', { name: /^שינוי סדר/ })).not.toBeInTheDocument();
    expect(screen.queryByText('↑')).not.toBeInTheDocument();
    expect(screen.queryByText('↓')).not.toBeInTheDocument();

    await user.click(within(systemCard).getByRole('button', { name: 'שינוי שם' }));
    const renameDialog = screen.getByRole('dialog', { name: 'שינוי שם מערכת / עמדה' });
    const renameInput = within(renameDialog).getByLabelText(/^שם חדש/);
    await user.clear(renameInput);
    await user.type(renameInput, 'מערכת לאחר שינוי');
    await user.click(within(renameDialog).getByRole('button', { name: 'שמירת השם' }));
    await screen.findByRole('heading', { name: 'מערכת לאחר שינוי' });

    systemCard = cardNamed('מערכת לאחר שינוי');
    await user.click(within(systemCard).getByRole('button', { name: 'השבתה' }));
    const deactivateDialog = screen.getByRole('dialog', { name: 'השבתת מערכת / עמדה' });
    expect(deactivateDialog).toHaveTextContent('לא תופיע בבחירה בעת פתיחת תקלה חדשה');
    await user.click(within(deactivateDialog).getByRole('button', { name: 'השבתה' }));
    systemCard = cardNamed('מערכת לאחר שינוי');
    await within(systemCard).findByText('לא פעיל');

    await user.click(within(systemCard).getByRole('button', { name: 'הפעלה מחדש' }));
    systemCard = cardNamed('מערכת לאחר שינוי');
    await within(systemCard).findByText('פעיל');

    const deleteSystemButton = within(systemCard).getByRole('button', {
      name: 'מחיקת מערכת לאחר שינוי',
    });
    expect(deleteSystemButton).toHaveAttribute('title', 'מחיקת מערכת לאחר שינוי');
    await user.click(deleteSystemButton);
    const deleteDialog = screen.getByRole('dialog', { name: 'מחיקת מערכת / עמדה' });
    expect(deleteDialog).toHaveTextContent('פריט שמקושר לתקלה או לרשומה היסטורית יישמר');
    await user.click(within(deleteDialog).getByRole('button', { name: 'בקשת מחיקה' }));
    expect(await screen.findByText(/נמחקה לצמיתות משום שלא הייתה בשימוש/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'מערכת לאחר שינוי' })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole('tab', { name: 'מיקומים' }));
    expect(screen.getByRole('tab', { name: 'מיקומים' })).toHaveAttribute('aria-selected', 'true');
    const locationName = 'מיקום בדיקת ניהול';
    await user.type(screen.getByLabelText(/^שם מיקום חדש/), locationName);
    await user.click(screen.getByRole('button', { name: 'הוספה' }));
    const locationCard = cardNamed(locationName);
    expect(within(locationCard).getByText('פעיל')).toBeInTheDocument();

    // Referenced deletion is visibly distinguished from physical deletion.
    await user.click(
      within(cardNamed('אתר 1')).getByRole('button', { name: 'מחיקת אתר 1' }),
    );
    const referencedDeleteDialog = screen.getByRole('dialog', { name: 'מחיקת מיקום' });
    await user.click(within(referencedDeleteDialog).getByRole('button', { name: 'בקשת מחיקה' }));
    expect(await screen.findByText(/המיקום נמצא בשימוש ולכן הועבר למצב לא פעיל/)).toBeInTheDocument();
    await within(cardNamed('אתר 1')).findByText('לא פעיל');
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
  it('reorders locations via the keyboard-focused drag handle and keeps the order after a refresh', async () => {
    stubSortableRowRects();
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await loginAdminAndOpenManagement(user);
    await user.click(screen.getByRole('tab', { name: 'מיקומים' }));
    await screen.findByRole('heading', { name: 'אתר 1' });

    expect(currentRecordOrder()).toEqual(['אתר 1', 'אתר 2', 'אתר 3', 'חדר בקרה ראשי']);

    const handle = screen.getByRole('button', { name: 'גרירה לשינוי סדר עבור אתר 1' });
    handle.focus();
    await user.keyboard(' '); // pick up
    await user.keyboard('{ArrowDown}'); // move one position down
    await user.keyboard(' '); // drop

    await waitFor(() => {
      expect(currentRecordOrder()).toEqual(['אתר 2', 'אתר 1', 'אתר 3', 'חדר בקרה ראשי']);
    });
    expect(within(cardNamed('אתר 1')).getByText(/סדר תצוגה: 2/)).toBeInTheDocument();
    expect(within(cardNamed('אתר 2')).getByText(/סדר תצוגה: 1/)).toBeInTheDocument();

    // Simulate a refresh: unmount the whole app tree and remount against the
    // same underlying (localStorage-backed) demo database. The demo session
    // itself is also persisted, so the remounted app lands directly back on
    // the already-authenticated admin screen without logging in again.
    unmount();
    render(<App />);
    await screen.findByRole('heading', { name: 'ניהול' });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'מיקומים' }));
    await screen.findByRole('heading', { name: 'אתר 1' });
    expect(currentRecordOrder()).toEqual(['אתר 2', 'אתר 1', 'אתר 3', 'חדר בקרה ראשי']);
  });

  it('restores the previous order and shows a Hebrew error toast when persistence fails', async () => {
    stubSortableRowRects();
    const user = userEvent.setup();
    render(<App />);
    await loginAdminAndOpenManagement(user);
    await user.click(screen.getByRole('tab', { name: 'מיקומים' }));
    await screen.findByRole('heading', { name: 'אתר 1' });
    expect(currentRecordOrder()).toEqual(['אתר 1', 'אתר 2', 'אתר 3', 'חדר בקרה ראשי']);

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
      expect(currentRecordOrder()).toEqual(['אתר 1', 'אתר 2', 'אתר 3', 'חדר בקרה ראשי']);
    });
    expect(reorderSpy).toHaveBeenCalledTimes(1);

    // The row's existing actions remain fully functional after a failed drag.
    await user.click(within(cardNamed('אתר 1')).getByRole('button', { name: 'שינוי שם' }));
    expect(screen.getByRole('dialog', { name: 'שינוי שם מיקום' })).toBeInTheDocument();
  });

  it('does not offer the drag handle to a role without reference-data permission', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByTestId('login-u-viewer'));
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    expect(screen.queryAllByRole('link', { name: 'ניהול' })).toHaveLength(0);

    window.history.pushState({}, '', '/admin');
    render(<App />);
    expect(screen.queryByRole('button', { name: /^גרירה לשינוי סדר/ })).not.toBeInTheDocument();
  });
});
