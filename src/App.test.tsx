// Component-level tests: mobile RTL layout and unauthorized-route protection,
// exercised through the real app (demo repository, real routing, real auth).
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

describe('RTL layout', () => {
  it('renders the document root as RTL Hebrew', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: 'AVARIA' });
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('he');
  });

  it('shows a mobile bottom navigation with at most four primary destinations after login', async () => {
    const user = userEvent.setup();
    render(<App />);
    const loginButton = await screen.findByTestId('login-u-supervisor-1');
    await user.click(loginButton);

    const bottomNav = await screen.findByRole('navigation', { name: 'ניווט תחתון' });
    const links = within(bottomNav).getAllByRole('link');
    // "פתיחת תקלה" is an extra floating action, not a primary destination link with text nav item styling —
    // it is still an <a>, so assert the four labeled destinations are present and total stays small.
    // supervisor1 is authorized for כוח אדם, which fills the slot freed by removing העברת משמרת from
    // primary navigation (the handover page/route are untouched, just not linked from here).
    const destinationLabels = links.map((l) => l.textContent);
    expect(destinationLabels).toEqual(
      expect.arrayContaining(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם']),
    );
    expect(destinationLabels).not.toContain('העברת משמרת');
    expect(links.length).toBeLessThanOrEqual(5); // 4 destinations + prominent create action
  });

  it('exposes the desktop sidebar as a "ניווט ראשי" navigation landmark with all destinations', async () => {
    const user = userEvent.setup();
    render(<App />);
    const loginButton = await screen.findByTestId('login-u-supervisor-1');
    await user.click(loginButton);

    const sidebarNav = await screen.findByRole('navigation', { name: 'ניווט ראשי' });
    const links = within(sidebarNav).getAllByRole('link');
    const labels = links.map((l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['מצב נוכחי', 'תקלות', 'ארכיון', 'כוח אדם']));
    expect(labels).not.toContain('העברת משמרת');
  });
});

describe('branding', () => {
  it('shows AVARIA as the primary brand identity on the login screen', async () => {
    render(<App />);
    const brandHeading = await screen.findByRole('heading', { name: 'AVARIA' });
    expect(brandHeading).toHaveAttribute('data-testid', 'brand-name');
    expect(within(brandHeading).getByRole('img', { name: 'AVARIA' })).toHaveAttribute(
      'src',
      '/branding/avaria-logo-full.png',
    );
    expect(screen.queryByRole('heading', { name: 'מעקב תקלות' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Takalot' })).not.toBeInTheDocument();
  });

  it('shows AVARIA branding in the application shell after login, not the legacy product name', async () => {
    const user = userEvent.setup();
    render(<App />);
    const loginButton = await screen.findByTestId('login-u-supervisor-1');
    await user.click(loginButton);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    const brandLinks = screen.getAllByTestId(/^brand-name/);
    expect(brandLinks.length).toBeGreaterThan(0);
    for (const link of brandLinks) {
      expect(link.textContent).toContain('AVARIA');
      expect(link.querySelector('img')).toHaveAttribute('src', '/branding/avaria-icon-512.png');
    }
    expect(screen.queryByText('מעקב תקלות', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText('Takalot', { exact: false })).not.toBeInTheDocument();
  });

  it('preserves the session-expired message inside the branded login presentation', async () => {
    localStorage.setItem('takalot-demo-session-user', 'missing-demo-user');

    render(<App />);

    expect(
      await screen.findByText(/פג תוקף ההתחברות\. יש להתחבר מחדש כדי להמשיך/),
    ).toHaveAttribute('role', 'alert');
    expect(screen.getByRole('heading', { name: 'AVARIA' })).toBeInTheDocument();
  });
});

describe('display-mode control', () => {
  it('switches and persists the stored theme preference', async () => {
    const user = userEvent.setup();
    render(<App />);
    const loginButton = await screen.findByTestId('login-u-supervisor-1');
    await user.click(loginButton);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    expect(localStorage.getItem('takalot-theme')).toBeNull(); // auto by default

    // A single direct toggle now — no dropdown/menu.
    const [toggle] = screen.getAllByTestId('theme-toggle');
    expect(toggle).toHaveAttribute('aria-label', 'מעבר למצב תצוגה כהה');
    await user.click(toggle);

    expect(localStorage.getItem('takalot-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(toggle).toHaveAttribute('aria-label', 'מעבר למצב תצוגה בהיר');

    await user.click(toggle);
    expect(localStorage.getItem('takalot-theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});

describe('unauthorized route protection', () => {
  it('blocks a viewer from the incident creation route', async () => {
    const user = userEvent.setup();
    render(<App />);
    const loginButton = await screen.findByTestId('login-u-viewer');
    await user.click(loginButton);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });

    // Simulate direct/unauthorized URL navigation: the session persists (demo
    // login is stored), a fresh mount at this URL must still be blocked.
    window.history.pushState({}, '', '/incidents/new');
    render(<App />);
    expect(await screen.findByText('אין הרשאה')).toBeInTheDocument();
  });

  it('does not show the "ניהול" admin destination to a non-admin role', async () => {
    const user = userEvent.setup();
    render(<App />);
    const loginButton = await screen.findByTestId('login-u-tech-1');
    await user.click(loginButton);
    await screen.findByRole('heading', { name: 'מצב נוכחי' });
    expect(screen.queryByRole('link', { name: 'ניהול' })).not.toBeInTheDocument();
  });
});
