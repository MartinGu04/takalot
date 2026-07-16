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
    await screen.findByText('מעקב תקלות');
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
    const destinationLabels = links.map((l) => l.textContent);
    expect(destinationLabels).toEqual(
      expect.arrayContaining(['מצב נוכחי', 'תקלות', 'העברת משמרת', 'ארכיון']),
    );
    expect(links.length).toBeLessThanOrEqual(5); // 4 destinations + prominent create action
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
