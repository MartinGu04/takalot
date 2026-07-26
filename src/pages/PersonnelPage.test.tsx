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
  // כוח אדם is now reachable from both the desktop sidebar and the mobile
  // bottom nav (jsdom renders both regardless of the md: breakpoint) --
  // scope to the desktop sidebar landmark to click just one.
  const sidebarNav = screen.getByRole('navigation', { name: 'ניווט ראשי' });
  await user.click(within(sidebarNav).getByRole('link', { name: 'כוח אדם' }));
  await screen.findByRole('heading', { name: 'כוח אדם' });
  return user;
}

function rowFor(fullName: string): HTMLElement {
  return within(main()).getByText(fullName).closest('[data-personnel-row]') as HTMLElement;
}

// כוח אדם is reachable from both the desktop sidebar and (for authorized
// roles) the mobile bottom nav -- jsdom renders both regardless of the md:
// breakpoint, so "shows כוח אדם" means at least one link exists, not exactly one.
describe('navigation visibility: shift_supervisor', () => {
  it('shows כוח אדם', async () => {
    await loginAs('login-u-supervisor-1');
    expect(screen.getAllByRole('link', { name: 'כוח אדם' }).length).toBeGreaterThan(0);
  });
});

describe('navigation visibility: professional_manager', () => {
  it('shows כוח אדם', async () => {
    await loginAs('login-u-manager');
    expect(screen.getAllByRole('link', { name: 'כוח אדם' }).length).toBeGreaterThan(0);
  });
});

describe('navigation visibility: system_admin', () => {
  it('shows כוח אדם', async () => {
    await loginAs('login-u-admin');
    expect(screen.getAllByRole('link', { name: 'כוח אדם' }).length).toBeGreaterThan(0);
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
    expect(optionLabels).toEqual(['טכנאי', 'צפייה בלבד']);
    expect(optionLabels).not.toContain('אחמ״ש');
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

  it('a professional_manager sees shift_supervisor, technician and viewer as role options -- never a peer professional_manager', async () => {
    const user = await openPersonnel('login-u-manager');
    await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));
    const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
    const optionLabels = within(within(dialog).getByLabelText(/^תפקיד/))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(optionLabels).toEqual(['אחמ״ש', 'טכנאי', 'צפייה בלבד']);
    expect(optionLabels).not.toContain('נגד');
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
  it('the role select and deactivate button are hidden by default; the row shows role as text and an עריכה toggle', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');
    const row = rowFor('עומר פרץ (דמו)');
    expect(within(row).getByText('טכנאי')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'עריכה' })).toBeInTheDocument();
  });

  it('a system_admin can expand עריכה to change a technician role and deactivate/reactivate them, both with confirmation', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    let row = rowFor('עומר פרץ (דמו)');
    await user.click(within(row).getByRole('button', { name: 'עריכה' }));
    row = rowFor('עומר פרץ (דמו)');
    await user.selectOptions(within(row).getByLabelText(/^תפקיד עומר פרץ/), 'shift_supervisor');
    const roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());
    // The panel collapses again after a successful change.
    expect(rowFor('עומר פרץ (דמו)').querySelector('[role="combobox"]')).not.toBeInTheDocument();

    row = rowFor('עומר פרץ (דמו)');
    await user.click(within(row).getByRole('button', { name: 'עריכה' }));
    row = rowFor('עומר פרץ (דמו)');
    await user.click(within(row).getByRole('button', { name: 'השבתה' }));
    const deactivateDialog = await screen.findByRole('dialog', { name: 'השבתת משתמש' });
    await user.click(within(deactivateDialog).getByRole('button', { name: 'השבתה' }));

    await waitFor(() => expect(within(main()).queryByText('עומר פרץ (דמו)')).not.toBeInTheDocument());
    await user.click(screen.getByRole('tab', { name: /^לא פעילים/ }));
    expect(await within(main()).findByText('עומר פרץ (דמו)')).toBeInTheDocument();
  });

  it('a shift_supervisor cannot manage a professional_manager (no controls, no עריכה toggle, above ceiling)', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('דנה לוי (דמו)');
    const row = rowFor('דנה לוי (דמו)');
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'עריכה' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'מחיקה' })).not.toBeInTheDocument();
  });

  it("no controls or עריכה toggle are shown for the signed-in user's own row (no self-service)", async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('אלון ברק (דמו)');
    const row = rowFor('אלון ברק (דמו)');
    expect(within(row).getByText('אתה')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'עריכה' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'מחיקה' })).not.toBeInTheDocument();
  });

  it('the sole active system_admin cannot be managed away: after returning to one active admin, that admin has no self-service controls', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));

    // Promote a second admin, then demote them back -- a 2 -> 1 transition
    // must succeed (it is not the protected transition).
    await within(main()).findByText('דנה לוי (דמו)');
    let managerRow = rowFor('דנה לוי (דמו)');
    await user.click(within(managerRow).getByRole('button', { name: 'עריכה' }));
    managerRow = rowFor('דנה לוי (דמו)');
    await user.selectOptions(within(managerRow).getByLabelText(/^תפקיד דנה לוי/), 'system_admin');
    let roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());

    managerRow = rowFor('דנה לוי (דמו)');
    await user.click(within(managerRow).getByRole('button', { name: 'עריכה' }));
    managerRow = rowFor('דנה לוי (דמו)');
    await user.selectOptions(within(managerRow).getByLabelText(/^תפקיד דנה לוי/), 'professional_manager');
    roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());

    // Back to exactly one active admin: their own row still shows no
    // controls (self-service is never offered, regardless of admin count).
    const ownRow = rowFor('אלון ברק (דמו)');
    expect(within(ownRow).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(ownRow).queryByRole('button', { name: 'עריכה' })).not.toBeInTheDocument();
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

describe('permanent deletion', () => {
  it('the confirm button stays disabled until the exact name is typed, and is re-armed on reopen', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('מאיה רוזן (דמו)');
    const row = rowFor('מאיה רוזן (דמו)');
    await user.click(within(row).getByRole('button', { name: 'מחיקה' }));

    const dialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
    const confirmButton = within(dialog).getByRole('button', { name: 'מחיקה לצמיתות' });
    expect(confirmButton).toBeDisabled();

    const typedField = within(dialog).getByLabelText(/^להמשך, יש להקליד את השם המדויק/);
    await user.type(typedField, 'שם שגוי');
    expect(confirmButton).toBeDisabled();

    await user.clear(typedField);
    await user.type(typedField, 'מאיה רוזן (דמו)');
    expect(confirmButton).not.toBeDisabled();

    // Closing and reopening must not leave the typed text (or the armed
    // confirm button) behind for the next target.
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'מחיקת משתמש לצמיתות' })).not.toBeInTheDocument());
    await user.click(within(rowFor('מאיה רוזן (דמו)')).getByRole('button', { name: 'מחיקה' }));
    const reopenedDialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
    expect(within(reopenedDialog).getByRole('button', { name: 'מחיקה לצמיתות' })).toBeDisabled();
  });

  it('the warning explains what deletion does and does not do', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('מאיה רוזן (דמו)');
    await user.click(within(rowFor('מאיה רוזן (דמו)')).getByRole('button', { name: 'מחיקה' }));
    const dialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
    expect(within(dialog).getByText(/בלתי הפיכה/)).toBeInTheDocument();
    expect(within(dialog).getByText(/חשבון ההתחברות הנוכחי של המשתמש ל-Nexus.*Supabase Auth/)).toBeInTheDocument();
    expect(within(dialog).getByText(/יסומן לצמיתות כ"נמחק"/)).toBeInTheDocument();
    // Split across nodes (the "לא" is a bold <span>) -- match on the <li>'s
    // full text content instead of a single text node.
    expect(dialog.textContent).toMatch(/היה מעורב בהם\s*לא\s*יימחקו/);
    // Must not say or imply that Nexus deletes the person's Google account.
    expect(dialog.textContent).not.toMatch(/Google.*יימחק/);
    expect(within(dialog).getByText(/אינה מוחקת את חשבון ה-Google החיצוני/)).toBeInTheDocument();
  });

  it('a system_admin can permanently delete a technician (no open incidents): success, נמחק badge, controls hidden', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('מאיה רוזן (דמו)');
    await user.click(within(rowFor('מאיה רוזן (דמו)')).getByRole('button', { name: 'מחיקה' }));

    const dialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
    await user.type(within(dialog).getByLabelText(/^להמשך, יש להקליד את השם המדויק/), 'מאיה רוזן (דמו)');
    await user.click(within(dialog).getByRole('button', { name: 'מחיקה לצמיתות' }));

    expect(await screen.findByText('המשתמש נמחק לצמיתות. חשבון ההתחברות הוסר.')).toBeInTheDocument();
    await waitFor(() => expect(within(main()).queryByText('מאיה רוזן (דמו)')).not.toBeInTheDocument());

    // Deleted profiles are not hidden -- they surface under the existing
    // לא פעילים tab (no new filter/tab introduced), with a נמחק badge and
    // no management controls.
    await user.click(screen.getByRole('tab', { name: /^לא פעילים/ }));
    const row = await within(main()).findByText('מאיה רוזן (דמו)');
    const rowEl = row.closest('[data-personnel-row]') as HTMLElement;
    expect(within(rowEl).getByText('נמחק')).toBeInTheDocument();
    expect(within(rowEl).getByText('אחמ״ש')).toBeInTheDocument(); // historical role preserved
    expect(within(rowEl).queryByRole('button', { name: 'עריכה' })).not.toBeInTheDocument();
    expect(within(rowEl).queryByRole('button', { name: 'מחיקה' })).not.toBeInTheDocument();
    expect(within(rowEl).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    expect(within(rowEl).queryByRole('button', { name: 'הפעלה' })).not.toBeInTheDocument();
    // The recovery-only action IS offered to an authorized manager.
    expect(within(rowEl).getByRole('button', { name: 'ווידוא הסרת חשבון ההתחברות' })).toBeInTheDocument();
  });

  it('deletion is blocked while the target owns an open incident, with the safe business message', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    // עומר פרץ (tech1) owns open incidents in the seed data.
    await within(main()).findByText('עומר פרץ (דמו)');
    await user.click(within(rowFor('עומר פרץ (דמו)')).getByRole('button', { name: 'מחיקה' }));
    const dialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
    await user.type(within(dialog).getByLabelText(/^להמשך, יש להקליד את השם המדויק/), 'עומר פרץ (דמו)');
    await user.click(within(dialog).getByRole('button', { name: 'מחיקה לצמיתות' }));

    expect(await screen.findByText('יש לשנות גורם מטפל בתקלות פתוחות לפני מחיקת המשתמש.')).toBeInTheDocument();
    // The dialog stays open on error (consistent with the rest of the
    // app's confirmation flows) and nothing changed: closing it manually
    // still shows the profile as active, unaffected.
    await user.click(within(dialog).getByRole('button', { name: 'ביטול' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'מחיקת משתמש לצמיתות' })).not.toBeInTheDocument());
    expect(within(main()).getByText('עומר פרץ (דמו)')).toBeInTheDocument();
  });

  it("a shift_supervisor cannot see מחיקה for a professional_manager (above ceiling); never for their own row", async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('דנה לוי (דמו)');
    expect(within(rowFor('דנה לוי (דמו)')).queryByRole('button', { name: 'מחיקה' })).not.toBeInTheDocument();
    expect(within(rowFor('יואב כהן (דמו)')).queryByRole('button', { name: 'מחיקה' })).not.toBeInTheDocument();
  });

  describe('DELETE_INCOMPLETE recovery', () => {
    // The demo repository cannot naturally produce a partial Auth-delete
    // failure (that's an Edge Function/Supabase Auth concern), so the
    // FIRST call is stubbed to perform the real tombstone (via the
    // captured original implementation) and then reject with
    // DELETE_INCOMPLETE, exactly like a real 502 with the DB step already
    // committed. Every other call (including the recovery retry) falls
    // through to the real, unmodified implementation.
    async function stubOneDeleteFailure() {
      // Both imported dynamically, AFTER this test's vi.resetModules(), so
      // this AppError is the SAME class the app's own module graph uses --
      // a statically/pre-reset-imported AppError would fail `instanceof`
      // checks inside the app's error handling and silently fall back to
      // a generic error instead of DELETE_INCOMPLETE.
      const { LocalDemoRepository } = await import('../data/local/localRepository');
      const { AppError } = await import('../data/repository');
      const original = LocalDemoRepository.prototype.deleteUser;
      const spy = vi.spyOn(LocalDemoRepository.prototype, 'deleteUser').mockImplementationOnce(async function (
        this: InstanceType<typeof LocalDemoRepository>,
        ...args: Parameters<typeof original>
      ) {
        await original.apply(this, args);
        throw new AppError(
          'DELETE_INCOMPLETE',
          'המשתמש הושבת ונחסם בבטחה, אך מחיקת חשבון ההתחברות נכשלה. יש לנסות שוב.',
        );
      });
      return spy;
    }

    it('refreshes the row to deleted, offers the recovery-only action, and a retry clears the error with a success toast', async () => {
      await stubOneDeleteFailure();
      const user = await openPersonnel('login-u-admin');
      await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
      await within(main()).findByText('מאיה רוזן (דמו)');
      await user.click(within(rowFor('מאיה רוזן (דמו)')).getByRole('button', { name: 'מחיקה' }));
      const dialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
      await user.type(within(dialog).getByLabelText(/^להמשך, יש להקליד את השם המדויק/), 'מאיה רוזן (דמו)');
      await user.click(within(dialog).getByRole('button', { name: 'מחיקה לצמיתות' }));

      expect(
        await screen.findByText('המשתמש הושבת ונחסם בבטחה, אך מחיקת חשבון ההתחברות נכשלה. יש לנסות שוב.'),
      ).toBeInTheDocument();
      // The dialog closes and the row already reflects the real (committed)
      // tombstone -- this is the exact contradiction being fixed: a
      // deleted row must expose a way to retry the Auth step.
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'מחיקת משתמש לצמיתות' })).not.toBeInTheDocument());
      await user.click(screen.getByRole('tab', { name: /^לא פעילים/ }));
      const row = await within(main()).findByText('מאיה רוזן (דמו)');
      const rowEl = row.closest('[data-personnel-row]') as HTMLElement;
      expect(within(rowEl).getByText('נמחק')).toBeInTheDocument();
      const recoverButton = within(rowEl).getByRole('button', { name: 'ווידוא הסרת חשבון ההתחברות' });
      expect(within(rowEl).queryByRole('button', { name: 'עריכה' })).not.toBeInTheDocument();
      expect(within(rowEl).queryByRole('button', { name: 'מחיקה' })).not.toBeInTheDocument();
      expect(within(rowEl).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
      expect(within(rowEl).queryByRole('button', { name: 'הפעלה' })).not.toBeInTheDocument();

      // The recovery action invokes delete-user again with the SAME
      // profile id -- this time (no stub queued) the real, idempotent
      // no-op path runs and succeeds.
      await user.click(recoverButton);
      const recoveryDialog = await screen.findByRole('dialog', { name: 'ווידוא הסרת חשבון ההתחברות' });
      expect(within(recoveryDialog).getByText(/כבר נמחק לצמיתות ומושבת/)).toBeInTheDocument();
      await user.click(within(recoveryDialog).getByRole('button', { name: 'ניסיון חוזר' }));

      expect(await screen.findByText('חשבון ההתחברות אומת כמוסר (או שכבר לא היה קיים).')).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'ווידוא הסרת חשבון ההתחברות' })).not.toBeInTheDocument(),
      );
      // Still deleted, still no ordinary controls, after a successful retry.
      const rowAfter = rowFor('מאיה רוזן (דמו)');
      expect(within(rowAfter).getByText('נמחק')).toBeInTheDocument();
      expect(within(rowAfter).queryByRole('button', { name: 'עריכה' })).not.toBeInTheDocument();
      expect(within(rowAfter).queryByRole('button', { name: 'מחיקה' })).not.toBeInTheDocument();
    });

    it('does not offer the recovery action to an out-of-ceiling actor for an already-deleted profile', async () => {
      // Tombstone a professional_manager (no incidents owned) as admin first.
      let user = await openPersonnel('login-u-admin');
      await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
      await within(main()).findByText('דנה לוי (דמו)');
      await user.click(within(rowFor('דנה לוי (דמו)')).getByRole('button', { name: 'מחיקה' }));
      const dialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
      await user.type(within(dialog).getByLabelText(/^להמשך, יש להקליד את השם המדויק/), 'דנה לוי (דמו)');
      await user.click(within(dialog).getByRole('button', { name: 'מחיקה לצמיתות' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'מחיקת משתמש לצמיתות' })).not.toBeInTheDocument());

      // Now view the same (already-deleted) profile as a shift_supervisor,
      // who is out of ceiling for a professional_manager either way. Log
      // out (same mounted app, no re-render) and sign in as a different
      // demo user instead of calling openPersonnel again.
      await user.click(screen.getByRole('button', { name: 'התנתקות' }));
      await user.click(await screen.findByTestId('login-u-supervisor-1'));
      await screen.findByRole('heading', { name: 'מצב נוכחי' });
      await user.click(within(screen.getByRole('navigation', { name: 'ניווט ראשי' })).getByRole('link', { name: 'כוח אדם' }));
      await screen.findByRole('heading', { name: 'כוח אדם' });
      await user.click(screen.getByRole('tab', { name: /^לא פעילים/ }));
      const row = await within(main()).findByText('דנה לוי (דמו)');
      const rowEl = row.closest('[data-personnel-row]') as HTMLElement;
      expect(within(rowEl).getByText('נמחק')).toBeInTheDocument();
      expect(within(rowEl).queryByRole('button', { name: 'ווידוא הסרת חשבון ההתחברות' })).not.toBeInTheDocument();
    });
  });
});
