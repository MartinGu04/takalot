// כוח אדם (personnel) page: exercised through the real app with the demo
// repository (real permission enforcement, real rules) -- not a UI mock.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type AppType from '../App';

// App.tsx holds its React Query cache in a MODULE-LEVEL singleton (shared
// across every render within one imported module instance). Several tests
// below query the same ['personnel'] key as different signed-in users in
// the same file; without a fresh module (and therefore a fresh cache) per
// test, a later test could transiently see a stale, wrong-user cache hit.
// Resetting modules and re-importing App per test gives each test its own
// QueryClient, exactly as a real page load would.
let App: typeof AppType;
beforeEach(async () => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
  vi.resetModules();
  App = (await import('../App')).default;
});

// Scope queries to <main> -- the desktop sidebar also shows the signed-in
// user's name in its footer, which would otherwise collide with that same
// person's row in the personnel list.
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

async function openPersonnel(userTestId: string) {
  const user = await loginAs(userTestId);
  await user.click(screen.getByRole('link', { name: 'כוח אדם' }));
  await screen.findByRole('heading', { name: 'כוח אדם' });
  return user;
}

function rowFor(fullName: string): HTMLElement {
  return within(main()).getByText(fullName).closest('.surface') as HTMLElement;
}

describe('navigation visibility: shift_supervisor', () => {
  it('shows כוח אדם', async () => {
    await loginAs('login-u-supervisor-1');
    expect(screen.getByRole('link', { name: 'כוח אדם' })).toBeInTheDocument();
  });
});

describe('navigation visibility: professional_manager', () => {
  it('shows כוח אדם', async () => {
    await loginAs('login-u-manager');
    expect(screen.getByRole('link', { name: 'כוח אדם' })).toBeInTheDocument();
  });
});

describe('navigation visibility: system_admin', () => {
  it('shows כוח אדם', async () => {
    await loginAs('login-u-admin');
    expect(screen.getByRole('link', { name: 'כוח אדם' })).toBeInTheDocument();
  });
});

describe('navigation visibility: technician', () => {
  it('does not show כוח אדם', async () => {
    await loginAs('login-u-tech-1');
    expect(screen.queryByRole('link', { name: 'כוח אדם' })).not.toBeInTheDocument();
  });
});

describe('navigation visibility: viewer', () => {
  it('does not show כוח אדם', async () => {
    await loginAs('login-u-viewer');
    expect(screen.queryByRole('link', { name: 'כוח אדם' })).not.toBeInTheDocument();
  });
});

describe('direct-route access', () => {
  it('blocks technician from /personnel by direct navigation', async () => {
    await loginAs('login-u-tech-1');
    window.history.pushState({}, '', '/personnel');
    render(<App />);
    expect(await screen.findByText('אין הרשאה')).toBeInTheDocument();
  });

  it('blocks viewer from /personnel by direct navigation', async () => {
    await loginAs('login-u-viewer');
    window.history.pushState({}, '', '/personnel');
    render(<App />);
    expect(await screen.findByText('אין הרשאה')).toBeInTheDocument();
  });

  it('allows shift_supervisor onto /personnel', async () => {
    await loginAs('login-u-supervisor-1');
    window.history.pushState({}, '', '/personnel');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'כוח אדם' })).toBeInTheDocument();
  });
});

describe('page structure and terminology', () => {
  it('shows the header, subtitle and tabs with counts; no UUID/Supabase wording anywhere on the page', async () => {
    await openPersonnel('login-u-admin');
    expect(screen.getByRole('heading', { name: 'כוח אדם' })).toBeInTheDocument();
    expect(screen.getByText('מי מורשה להיכנס ל־Nexus ובאיזה תפקיד')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^ממתינים להתחברות/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^פעילים/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^לא פעילים/ })).toBeInTheDocument();

    const uuidLike = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(main().textContent).not.toMatch(uuidLike);
    expect(main().textContent).not.toMatch(/supabase/i);
    expect(main().textContent).not.toMatch(/database|מסד נתונים|dashboard/i);
  });

  it('switching to פעילים shows the seeded active linked users', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    expect(await within(main()).findByText('אלון ברק (דמו)')).toBeInTheDocument();
    expect(within(main()).getByText('עומר פרץ (דמו)')).toBeInTheDocument();
  });

  it('shows the empty-pending message when there are no pending entries', async () => {
    await openPersonnel('login-u-admin');
    expect(await within(main()).findByText('אין כרגע אנשי צוות שממתינים להתחברות.')).toBeInTheDocument();
  });

  it('shows the empty-inactive message when there are no inactive personnel', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^לא פעילים/ }));
    expect(await within(main()).findByText('אין אנשי צוות לא פעילים.')).toBeInTheDocument();
  });
});

describe('adding personnel', () => {
  it('a shift_supervisor can add a technician; role options are limited to their ceiling; success shows the normal-login message', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));

    const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
    const roleSelect = within(dialog).getByLabelText(/^תפקיד/);
    const optionLabels = within(roleSelect).getAllByRole('option').map((o) => o.textContent);
    expect(optionLabels).toEqual(['אחמ״ש', 'טכנאי']);
    expect(optionLabels).not.toContain('נגד');
    expect(optionLabels).not.toContain('מנהל מערכת');

    await user.type(within(dialog).getByLabelText(/^שם מלא/), 'טכנאי חדש');
    await user.type(within(dialog).getByLabelText(/^כתובת חשבון Google/), 'new.tech@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'הוספה' }));

    expect(
      await screen.findByText(
        'איש הצוות נוסף וממתין להתחברות הראשונה עם חשבון Google שהוגדר. אין צורך בקישור מיוחד — יש להיכנס לכתובת הרגילה של Nexus.',
      ),
    ).toBeInTheDocument();
    expect(await within(main()).findByText('טכנאי חדש')).toBeInTheDocument();
    expect(within(main()).getByText('new.tech@example.com')).toBeInTheDocument();
  });

  it('a professional_manager sees technician, shift_supervisor and professional_manager as role options', async () => {
    const user = await openPersonnel('login-u-manager');
    await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));
    const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
    const optionLabels = within(within(dialog).getByLabelText(/^תפקיד/))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(optionLabels).toEqual(['נגד', 'אחמ״ש', 'טכנאי']);
  });

  it('a system_admin sees every role, including מנהל מערכת', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));
    const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
    const optionLabels = within(within(dialog).getByLabelText(/^תפקיד/))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(optionLabels).toContain('מנהל מערכת');
  });
});

describe('editing and cancelling a pending entry', () => {
  async function addPending(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));
    const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
    await user.type(within(dialog).getByLabelText(/^שם מלא/), 'ממתין לבדיקה');
    await user.type(within(dialog).getByLabelText(/^כתובת חשבון Google/), 'pending.check@example.com');
    await user.click(within(dialog).getByRole('button', { name: 'הוספה' }));
    await within(main()).findByText('ממתין לבדיקה');
  }

  it('editing updates the name of a pending entry', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await addPending(user);

    const row = rowFor('ממתין לבדיקה');
    await user.click(within(row).getByRole('button', { name: 'עריכה' }));
    const dialog = await screen.findByRole('dialog', { name: 'עריכת רישום ממתין' });
    const nameField = within(dialog).getByLabelText(/^שם מלא/) as HTMLInputElement;
    await user.clear(nameField);
    await user.type(nameField, 'שם עודכן');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    expect(await within(main()).findByText('שם עודכן')).toBeInTheDocument();
    expect(within(main()).queryByText('ממתין לבדיקה')).not.toBeInTheDocument();
  });

  it('cancelling requires confirmation and removes the entry from the pending tab', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await addPending(user);

    const row = rowFor('ממתין לבדיקה');
    await user.click(within(row).getByRole('button', { name: 'ביטול' }));
    const confirmDialog = await screen.findByRole('dialog', { name: 'ביטול רישום ממתין' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'ביטול הרישום' }));

    await waitFor(() => expect(within(main()).queryByText('ממתין לבדיקה')).not.toBeInTheDocument());
    expect(await within(main()).findByText('אין כרגע אנשי צוות שממתינים להתחברות.')).toBeInTheDocument();
  });
});

describe('linked user management and safety rules', () => {
  it('a system_admin can change a technician role and deactivate/reactivate them, both with confirmation', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    const row = rowFor('עומר פרץ (דמו)');
    await user.selectOptions(within(row).getByLabelText(/^תפקיד עומר פרץ/), 'shift_supervisor');
    const roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());

    const updatedRow = rowFor('עומר פרץ (דמו)');
    await user.click(within(updatedRow).getByRole('button', { name: 'השבתה' }));
    const deactivateDialog = await screen.findByRole('dialog', { name: 'השבתת משתמש' });
    await user.click(within(deactivateDialog).getByRole('button', { name: 'השבתה' }));

    await waitFor(() => expect(within(main()).queryByText('עומר פרץ (דמו)')).not.toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: /^לא פעילים/ }));
    expect(await within(main()).findByText('עומר פרץ (דמו)')).toBeInTheDocument();
  });

  it('a shift_supervisor cannot manage a professional_manager (no controls shown, above ceiling)', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('דנה לוי (דמו)');
    const row = rowFor('דנה לוי (דמו)');
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
  });

  it("no controls are shown for the signed-in user's own row (no self-service)", async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('אלון ברק (דמו)');
    const row = rowFor('אלון ברק (דמו)');
    expect(within(row).getByText('אתה')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
  });

  it('the sole active system_admin cannot be managed away: after returning to one active admin, that admin has no self-service controls', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));

    // Promote a second admin, then demote them back -- a 2 -> 1 transition
    // must succeed (it is not the protected transition).
    await within(main()).findByText('דנה לוי (דמו)');
    let managerRow = rowFor('דנה לוי (דמו)');
    await user.selectOptions(within(managerRow).getByLabelText(/^תפקיד דנה לוי/), 'system_admin');
    let roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());

    managerRow = rowFor('דנה לוי (דמו)');
    await user.selectOptions(within(managerRow).getByLabelText(/^תפקיד דנה לוי/), 'professional_manager');
    roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());

    // Back to exactly one active admin: their own row still shows no
    // controls (self-service is never offered, regardless of admin count).
    const ownRow = rowFor('אלון ברק (דמו)');
    expect(within(ownRow).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(ownRow).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
  });
});

describe('search', () => {
  it('filters by name or Google email within the active tab', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('אלון ברק (דמו)');
    await user.type(screen.getByLabelText('חיפוש לפי שם או כתובת Google'), 'עומר');
    expect(within(main()).getByText('עומר פרץ (דמו)')).toBeInTheDocument();
    expect(within(main()).queryByText('אלון ברק (דמו)')).not.toBeInTheDocument();
  });
});
