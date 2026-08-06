// Mobile bottom-nav overflow ("עוד"): the bottom nav keeps a fixed 4-slot
// layout. Roles with 4 or fewer destinations (technician, viewer) get all of
// them as direct links, including ניתוחים. Roles with more than 4
// (shift_supervisor, professional_manager, system_admin) get 3 direct links
// plus a 4th "עוד" slot that opens a sheet with the remaining destinations
// (כוח אדם / ניהול / ניתוחים, whichever the role is permitted). Exercised
// through the real app (real routing/auth), not a Layout-level unit mock.
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';
import { APP_VERSION_LABEL } from '../config/appVersion';

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

async function login(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.click(await screen.findByTestId(testId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
}

function bottomNav() {
  return screen.getByRole('navigation', { name: 'ניווט תחתון' });
}

describe('mobile bottom-nav overflow (עוד)', () => {
  it.each([
    ['viewer', 'login-u-viewer'],
    ['technician', 'login-u-tech-1'],
  ])('%s: keeps all 4 destinations as direct links, including ניתוחים, with no עוד button', async (_role, testId) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);

    const nav = bottomNav();
    const links = within(nav).getAllByRole('link').filter((l) => l.textContent);
    expect(links.map((l) => l.textContent)).toEqual(['מצב נוכחי', 'תקלות', 'ארכיון', 'ניתוחים']);
    expect(within(nav).queryByRole('button', { name: 'עוד' })).not.toBeInTheDocument();
  });

  it.each([
    ['shift_supervisor', 'login-u-supervisor-1', ['כוח אדם', 'ניתוחים']],
    ['professional_manager', 'login-u-manager', ['כוח אדם', 'יומן ביקורת', 'ניתוחים']],
    ['system_admin', 'login-u-admin', ['כוח אדם', 'ניהול', 'יומן ביקורת', 'ניתוחים']],
  ] as const)(
    '%s: shows 3 direct destinations plus an עוד slot holding %o',
    async (_role, testId, expectedOverflow) => {
      const user = userEvent.setup();
      render(<App />);
      await login(user, testId);

      const nav = bottomNav();
      const directLinks = within(nav).getAllByRole('link').filter((l) => l.textContent);
      expect(directLinks.map((l) => l.textContent)).toEqual(['מצב נוכחי', 'תקלות', 'ארכיון']);

      const moreButton = within(nav).getByRole('button', { name: 'עוד' });
      expect(moreButton).toHaveAttribute('aria-haspopup', 'dialog');
      expect(moreButton).toHaveAttribute('aria-expanded', 'false');
      // Destinations that only belong in the overflow sheet must not leak
      // into the bottom nav as direct links.
      for (const label of expectedOverflow) {
        expect(within(nav).queryByRole('link', { name: label })).not.toBeInTheDocument();
      }

      await user.click(moreButton);
      expect(moreButton).toHaveAttribute('aria-expanded', 'true');
      const sheet = screen.getByRole('dialog', { name: 'עוד' });
      const sheetLinks = within(sheet).getAllByRole('link');
      expect(sheetLinks.map((l) => l.textContent)).toEqual(expectedOverflow);

      // Never exposes a destination the role can't access.
      if (!(expectedOverflow as readonly string[]).includes('ניהול')) {
        expect(within(sheet).queryByRole('link', { name: 'ניהול' })).not.toBeInTheDocument();
      }
    },
  );

  it('closes the עוד sheet and navigates when a destination inside it is selected', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    const nav = bottomNav();
    await user.click(within(nav).getByRole('button', { name: 'עוד' }));
    const sheet = screen.getByRole('dialog', { name: 'עוד' });
    await user.click(within(sheet).getByRole('link', { name: 'ניתוחים' }));

    await screen.findByRole('heading', { name: 'ניתוח תקלות' });
    expect(screen.queryByRole('dialog', { name: 'עוד' })).not.toBeInTheDocument();
    expect(within(bottomNav()).getByRole('button', { name: 'עוד' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('marks עוד as the active destination and highlights the matching item inside the sheet, while on a route held in overflow', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    const nav = bottomNav();
    const moreButton = within(nav).getByRole('button', { name: 'עוד' });
    expect(moreButton).not.toHaveAttribute('aria-current', 'page');

    await user.click(moreButton);
    const sheet = screen.getByRole('dialog', { name: 'עוד' });
    await user.click(within(sheet).getByRole('link', { name: 'ניהול' }));
    await screen.findByRole('heading', { name: 'ניהול' });

    expect(within(bottomNav()).getByRole('button', { name: 'עוד' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(within(bottomNav()).getByRole('button', { name: 'עוד' }));
    const reopenedSheet = screen.getByRole('dialog', { name: 'עוד' });
    expect(within(reopenedSheet).getByRole('link', { name: 'ניהול' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(reopenedSheet).getByRole('link', { name: 'כוח אדם' })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('dismisses the עוד sheet on Escape', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    await user.click(within(bottomNav()).getByRole('button', { name: 'עוד' }));
    expect(screen.getByRole('dialog', { name: 'עוד' })).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'עוד' })).not.toBeInTheDocument();
  });

  it('is keyboard-operable: Tab reaches עוד, Enter opens it, and its links are reachable by Tab', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    const moreButton = within(bottomNav()).getByRole('button', { name: 'עוד' });
    moreButton.focus();
    expect(moreButton).toHaveFocus();
    await user.keyboard('{Enter}');

    const sheet = await screen.findByRole('dialog', { name: 'עוד' });
    // The sheet moves focus to its own close button on open (shared Dialog
    // behavior); the destination links are the very next stop on Tab.
    expect(within(sheet).getByRole('button', { name: 'סגירת החלון' })).toHaveFocus();
    await user.tab();
    expect(within(sheet).getAllByRole('link')[0]).toHaveFocus();
  });

  it('desktop sidebar is unaffected: it still lists every destination directly, with no עוד control', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    const labels = within(sidebar).getAllByRole('link').map((l) => l.textContent);
    expect(labels).toEqual(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם', 'ניהול', 'יומן ביקורת', 'ניתוחים']);
    expect(within(sidebar).queryByRole('button', { name: 'עוד' })).not.toBeInTheDocument();
  });
});

describe('AVARIA v1.2.0 version display', () => {
  it('renders "AVARIA v1.2.0" in the desktop sidebar, above the user/divider section, using the shared version source', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' }).closest('aside') as HTMLElement;
    const versionEl = within(sidebar).getByTestId('app-version');
    expect(versionEl).toHaveTextContent(APP_VERSION_LABEL);
    expect(versionEl.textContent).toBe('AVARIA v1.2.0');

    // "Directly above the divider/user section": the version element and the
    // bordered user-section container are adjacent siblings, in that order.
    const userSectionDiv = sidebar.querySelector('.border-t.border-hairline');
    expect(versionEl.nextElementSibling).toBe(userSectionDiv);
  });

  it('renders the same "AVARIA v1.2.0" version at the bottom of the mobile עוד screen', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    await user.click(within(bottomNav()).getByRole('button', { name: 'עוד' }));
    const sheet = screen.getByRole('dialog', { name: 'עוד' });
    const versionEl = within(sheet).getByTestId('app-version');
    expect(versionEl).toHaveTextContent(APP_VERSION_LABEL);
    expect(versionEl.textContent).toBe('AVARIA v1.2.0');
  });
});

describe('desktop header: department logos', () => {
  it('renders alongside the existing header controls, which stay fully present and functional', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-admin');

    const header = document.querySelector('header') as HTMLElement;
    expect(within(header).getByTestId('department-logos')).toBeInTheDocument();
    expect(within(header).getByTestId('department-logo-502')).toBeInTheDocument();
    expect(within(header).getByTestId('department-logo-strategic-communication')).toBeInTheDocument();

    // Existing controls untouched: notifications button still opens its panel.
    const notifButton = within(header).getByTestId('notifications-button');
    expect(notifButton).toBeInTheDocument();
    await user.click(notifButton);
    // The panel is portaled to document.body (FloatingPopover), not a
    // descendant of <header> -- assert globally.
    expect(await screen.findByText('התראות')).toBeInTheDocument();

    // The live clock is still rendered (its own centering is a real-layout
    // concern, verified in e2e/34-department-logos.spec.ts).
    expect(within(header).getByTestId('desktop-live-clock')).toBeInTheDocument();
  });
});
