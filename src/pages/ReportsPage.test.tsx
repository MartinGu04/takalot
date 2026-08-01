// דוחות (Reports): future-feature placeholder, exposed to every authenticated
// role with no capability gate. Exercised through the real app (real
// routing/auth guard), not a page-level unit mock.
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
});

async function login(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.click(await screen.findByTestId(testId));
  await screen.findByRole('heading', { name: 'מצב נוכחי' });
}

describe('Reports navigation destination', () => {
  it('renders the דוחות destination in both the desktop sidebar and the mobile bottom nav for an authenticated user', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    expect(within(sidebar).getByRole('link', { name: 'דוחות' })).toBeInTheDocument();

    const bottomNav = screen.getByRole('navigation', { name: 'ניווט תחתון' });
    expect(within(bottomNav).getByRole('link', { name: 'דוחות' })).toBeInTheDocument();
  });

  it.each([
    ['system_admin', 'login-u-admin'],
    ['professional_manager', 'login-u-manager'],
    ['shift_supervisor', 'login-u-supervisor-1'],
    ['technician', 'login-u-tech-1'],
    ['viewer', 'login-u-viewer'],
  ])('exposes דוחות to the %s role with no restriction', async (_role, testId) => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, testId);

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    expect(within(sidebar).getByRole('link', { name: 'דוחות' })).toBeInTheDocument();
  });

  it('navigates to the Reports route, renders the coming-soon composition, and marks active-route state correctly', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-viewer');

    const sidebar = screen.getByRole('navigation', { name: 'ניווט ראשי' });
    const reportsLink = within(sidebar).getByRole('link', { name: 'דוחות' });
    expect(reportsLink).not.toHaveAttribute('aria-current', 'page');
    const dashboardLink = within(sidebar).getByRole('link', { name: 'מצב נוכחי' });
    expect(dashboardLink).toHaveAttribute('aria-current', 'page');

    await user.click(reportsLink);

    await screen.findByRole('heading', { name: 'דוחות' });
    expect(screen.getByText('COMING SOON')).toBeInTheDocument();
    expect(
      screen.getByText('מרכז הדוחות והניתוחים של AVARIA יתווסף בגרסה עתידית.'),
    ).toBeInTheDocument();

    expect(reportsLink).toHaveAttribute('aria-current', 'page');
    expect(dashboardLink).not.toHaveAttribute('aria-current', 'page');
  });

  it('is reachable by direct route access for an already-authenticated session', async () => {
    const user = userEvent.setup();
    render(<App />);
    await login(user, 'login-u-supervisor-1');

    // Simulate a deep link / refresh landing straight on /reports.
    window.history.pushState({}, '', '/reports');
    render(<App />);

    await screen.findByRole('heading', { name: 'דוחות' });
    expect(screen.queryByText('אין הרשאה')).not.toBeInTheDocument();
  });

  it('redirects an unauthenticated direct visit to /reports to the login screen', async () => {
    window.history.pushState({}, '', '/reports');
    render(<App />);

    await screen.findByRole('heading', { name: 'AVARIA' });
    expect(screen.queryByRole('heading', { name: 'דוחות' })).not.toBeInTheDocument();
  });
});
