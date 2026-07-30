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
const INC5_TEXT = /מערכת בטא הושבתה לחלוטין למשך הטיפול/; // inc-5: seeded closed

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
