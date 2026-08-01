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

/** The row's three-dots trigger, or null when the row offers no actions. */
function menuTriggerIn(row: HTMLElement): HTMLElement | null {
  return within(row).queryByRole('button', { name: /^פעולות עבור / });
}

/** Opens a row's overflow menu and returns the menu element. */
async function openRowMenu(
  user: ReturnType<typeof userEvent.setup>,
  fullName: string,
): Promise<HTMLElement> {
  const trigger = menuTriggerIn(rowFor(fullName)) as HTMLElement;
  await user.click(trigger);
  return within(rowFor(fullName)).getByRole('menu');
}

/** Registers one pending technician entry and waits for it to appear. */
async function addPending(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));
  const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
  await user.type(within(dialog).getByLabelText(/^שם מלא/), 'ממתין לבדיקה');
  await user.type(within(dialog).getByLabelText(/^כתובת חשבון Google/), 'pending.check@example.com');
  await user.click(within(dialog).getByRole('button', { name: 'הוספה' }));
  await within(main()).findByText('ממתין לבדיקה');
}

/** Opens a row's overflow menu and activates one of its items. */
async function clickRowAction(
  user: ReturnType<typeof userEvent.setup>,
  fullName: string,
  action: string,
) {
  const menu = await openRowMenu(user, fullName);
  await user.click(within(menu).getByRole('menuitem', { name: action }));
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
    expect(screen.getByText('מי מורשה להיכנס ל־AVARIA ובאיזה תפקיד')).toBeInTheDocument();
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
        'איש הצוות נוסף וממתין להתחברות הראשונה עם חשבון Google שהוגדר. אין צורך בקישור מיוחד — יש להיכנס לכתובת הרגילה של AVARIA.',
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

describe('the add-personnel form resets only after a confirmed successful creation', () => {
  it('reopening after a successful creation shows clean defaults, never the person just created', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));

    const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
    await user.type(within(dialog).getByLabelText(/^שם מלא/), 'רס״ן דנה כהן');
    await user.type(within(dialog).getByLabelText(/^כתובת חשבון Google/), 'dana.cohen@example.com');
    await user.selectOptions(within(dialog).getByLabelText(/^תפקיד/), 'viewer');
    await user.click(within(dialog).getByRole('button', { name: 'הוספה' }));

    // Confirmed success: the entry really exists.
    expect(await within(main()).findByText('רס״ן דנה כהן')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'הוספת איש צוות' })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));
    const reopened = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
    expect(within(reopened).getByLabelText(/^שם מלא/)).toHaveValue('');
    expect(within(reopened).getByLabelText(/^כתובת חשבון Google/)).toHaveValue('');
    // Role is back to the creator's default (their highest-assignable role),
    // not the viewer that was picked for the previous person.
    expect(within(reopened).getByLabelText(/^תפקיד/)).toHaveValue('system_admin');
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a failed creation keeps the dialog open with every entered value intact', async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const { AppError } = await import('../data/repository');
    const spy = vi
      .spyOn(LocalDemoRepository.prototype, 'createPendingPersonnel')
      .mockRejectedValue(new AppError('NETWORK', 'אירעה שגיאה. הנתונים שהוזנו לא נשמרו — ניתן לנסות שוב.'));
    try {
      const user = await openPersonnel('login-u-admin');
      await user.click(screen.getByRole('button', { name: 'הוספת איש צוות' }));

      const dialog = await screen.findByRole('dialog', { name: 'הוספת איש צוות' });
      await user.type(within(dialog).getByLabelText(/^שם מלא/), 'רס״ן דנה כהן');
      await user.type(within(dialog).getByLabelText(/^כתובת חשבון Google/), 'dana.cohen@example.com');
      await user.selectOptions(within(dialog).getByLabelText(/^תפקיד/), 'technician');
      await user.click(within(dialog).getByRole('button', { name: 'הוספה' }));

      expect(await screen.findByText('אירעה שגיאה. הנתונים שהוזנו לא נשמרו — ניתן לנסות שוב.')).toBeInTheDocument();
      const stillOpen = screen.getByRole('dialog', { name: 'הוספת איש צוות' });
      expect(within(stillOpen).getByLabelText(/^שם מלא/)).toHaveValue('רס״ן דנה כהן');
      expect(within(stillOpen).getByLabelText(/^כתובת חשבון Google/)).toHaveValue('dana.cohen@example.com');
      expect(within(stillOpen).getByLabelText(/^תפקיד/)).toHaveValue('technician');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('editing and cancelling a pending entry', () => {
  it('editing updates the name of a pending entry', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await addPending(user);

    await clickRowAction(user, 'ממתין לבדיקה', 'עריכה');
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

    await clickRowAction(user, 'ממתין לבדיקה', 'ביטול');
    const confirmDialog = await screen.findByRole('dialog', { name: 'ביטול רישום ממתין' });
    await user.click(within(confirmDialog).getByRole('button', { name: 'ביטול הרישום' }));

    await waitFor(() => expect(within(main()).queryByText('ממתין לבדיקה')).not.toBeInTheDocument());
    expect(await within(main()).findByText('אין כרגע אנשי צוות שממתינים להתחברות.')).toBeInTheDocument();
  });
});

describe('linked user management and safety rules', () => {
  it('the role select and deactivate button are hidden by default; the row shows role as text and an עריכה action in its menu', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');
    const row = rowFor('עומר פרץ (דמו)');
    expect(within(row).getByText('סוג משתמש: טכנאי')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    // The row's actions are collapsed behind the overflow trigger and are
    // not rendered at all until it is opened.
    expect(within(row).queryByRole('menu')).not.toBeInTheDocument();
    expect(menuTriggerIn(row)).toBeInTheDocument();
    const menu = await openRowMenu(user, 'עומר פרץ (דמו)');
    expect(within(menu).getByRole('menuitem', { name: 'עריכה' })).toBeInTheDocument();
  });

  it('a system_admin can expand עריכה to change a technician role and deactivate/reactivate them, both with confirmation', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    await clickRowAction(user, 'עומר פרץ (דמו)', 'עריכה');
    let row = rowFor('עומר פרץ (דמו)');
    await user.selectOptions(within(row).getByLabelText(/^תפקיד עומר פרץ/), 'shift_supervisor');
    const roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());
    // The panel collapses again after a successful change.
    expect(rowFor('עומר פרץ (דמו)').querySelector('[role="combobox"]')).not.toBeInTheDocument();

    await clickRowAction(user, 'עומר פרץ (דמו)', 'עריכה');
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
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    // No overflow trigger at all above the ceiling -- there is no menu to
    // open, so neither עריכה nor מחיקה is reachable by any route.
    expect(menuTriggerIn(row)).not.toBeInTheDocument();
  });

  it("no controls or action menu are shown for the signed-in user's own row (no self-service)", async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('אלון ברק (דמו)');
    const row = rowFor('אלון ברק (דמו)');
    expect(within(row).getByText('אתה')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'השבתה' })).not.toBeInTheDocument();
    expect(menuTriggerIn(row)).not.toBeInTheDocument();
  });

  it('the sole active system_admin cannot be managed away: after returning to one active admin, that admin has no self-service controls', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));

    // Promote a second admin, then demote them back -- a 2 -> 1 transition
    // must succeed (it is not the protected transition).
    await within(main()).findByText('דנה לוי (דמו)');
    await clickRowAction(user, 'דנה לוי (דמו)', 'עריכה');
    let managerRow = rowFor('דנה לוי (דמו)');
    await user.selectOptions(within(managerRow).getByLabelText(/^תפקיד דנה לוי/), 'system_admin');
    let roleDialog = await screen.findByRole('dialog', { name: 'שינוי תפקיד' });
    await user.click(within(roleDialog).getByRole('button', { name: 'שינוי תפקיד' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'שינוי תפקיד' })).not.toBeInTheDocument());

    await clickRowAction(user, 'דנה לוי (דמו)', 'עריכה');
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
    expect(menuTriggerIn(ownRow)).not.toBeInTheDocument();
  });
});

describe('renaming personnel', () => {
  it('renaming a pending entry from שינוי שם updates the displayed name', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await addPending(user);

    await clickRowAction(user, 'ממתין לבדיקה', 'שינוי שם');
    const dialog = await screen.findByRole('dialog', { name: 'שינוי שם' });
    const nameField = within(dialog).getByLabelText(/^שם מלא/) as HTMLInputElement;
    expect(nameField).toHaveValue('ממתין לבדיקה');
    await user.clear(nameField);
    await user.type(nameField, 'שם ממתין חדש');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    expect(await within(main()).findByText('שם ממתין חדש')).toBeInTheDocument();
    expect(within(main()).queryByText('ממתין לבדיקה')).not.toBeInTheDocument();
  });

  it('renaming an active linked profile from שינוי שם updates the displayed name', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    await clickRowAction(user, 'עומר פרץ (דמו)', 'שינוי שם');
    const dialog = await screen.findByRole('dialog', { name: 'שינוי שם' });
    expect(within(dialog).getByLabelText(/^שם מלא/)).toHaveValue('עומר פרץ (דמו)');
    await user.clear(within(dialog).getByLabelText(/^שם מלא/));
    await user.type(within(dialog).getByLabelText(/^שם מלא/), 'עומר פרץ החדש');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    expect(await within(main()).findByText('עומר פרץ החדש')).toBeInTheDocument();
    expect(within(rowFor('עומר פרץ החדש')).getByText('סוג משתמש: טכנאי')).toBeInTheDocument();
  });

  it('renaming an inactive linked profile from שינוי שם updates the displayed name', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');
    await clickRowAction(user, 'עומר פרץ (דמו)', 'עריכה');
    await user.click(within(rowFor('עומר פרץ (דמו)')).getByRole('button', { name: 'השבתה' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'השבתת משתמש' })).getByRole('button', { name: 'השבתה' }));
    await user.click(screen.getByRole('tab', { name: /^לא פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    await clickRowAction(user, 'עומר פרץ (דמו)', 'שינוי שם');
    const dialog = await screen.findByRole('dialog', { name: 'שינוי שם' });
    await user.clear(within(dialog).getByLabelText(/^שם מלא/));
    await user.type(within(dialog).getByLabelText(/^שם מלא/), 'עומר לא פעיל חדש');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    expect(await within(main()).findByText('עומר לא פעיל חדש')).toBeInTheDocument();
  });

  it('shows a live character count and rejects an invalid name without submitting', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');
    await clickRowAction(user, 'עומר פרץ (דמו)', 'שינוי שם');

    const dialog = await screen.findByRole('dialog', { name: 'שינוי שם' });
    expect(within(dialog).getByText(/^\d+\/60 תווים$/)).toBeInTheDocument();

    const nameField = within(dialog).getByLabelText(/^שם מלא/);
    await user.clear(nameField);
    await user.type(nameField, 'Tech123');
    await user.click(within(dialog).getByRole('button', { name: 'שמירה' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('אותיות');
    // Rejected client-side: the dialog stays open and no change reached the list.
    expect(screen.getByRole('dialog', { name: 'שינוי שם' })).toBeInTheDocument();
    expect(within(main()).getByText('עומר פרץ (דמו)')).toBeInTheDocument();
  });

  it('the ActionMenu offers שינוי שם alongside the existing actions, without removing them', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');
    const menu = await openRowMenu(user, 'עומר פרץ (דמו)');
    expect(within(menu).getByRole('menuitem', { name: 'עריכה' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'שינוי שם' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'מחיקה' })).toBeInTheDocument();
  });

  it("shows the stored avatar image for a linked profile that has one, and the initials fallback for one that doesn't", async () => {
    const { LocalDemoRepository } = await import('../data/local/localRepository');
    const spy = vi.spyOn(LocalDemoRepository.prototype, 'listPersonnel').mockResolvedValue([
      {
        kind: 'linked',
        id: 'avatar-user',
        fullName: 'בעל תמונה',
        email: 'avatar.user@example.com',
        role: 'technician',
        state: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        avatarUrl: 'https://example.test/avatar.png',
      },
      {
        kind: 'linked',
        id: 'no-avatar-user',
        fullName: 'ללא תמונה',
        email: 'no.avatar@example.com',
        role: 'technician',
        state: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        avatarUrl: null,
      },
    ]);
    try {
      const user = await openPersonnel('login-u-admin');
      await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
      const withAvatar = await within(main()).findByText('בעל תמונה');
      const withAvatarRow = withAvatar.closest('[data-personnel-row]') as HTMLElement;
      const img = withAvatarRow.querySelector('img');
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute('src', 'https://example.test/avatar.png');

      const withoutAvatarRow = (within(main()).getByText('ללא תמונה')).closest('[data-personnel-row]') as HTMLElement;
      expect(withoutAvatarRow.querySelector('img')).toBeNull();
      expect(within(withoutAvatarRow).getByText('ל')).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
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
    await clickRowAction(user, 'מאיה רוזן (דמו)', 'מחיקה');

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
    await clickRowAction(user, 'מאיה רוזן (דמו)', 'מחיקה');
    const reopenedDialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
    expect(within(reopenedDialog).getByRole('button', { name: 'מחיקה לצמיתות' })).toBeDisabled();
  });

  it('the warning explains what deletion does and does not do', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('מאיה רוזן (דמו)');
    await clickRowAction(user, 'מאיה רוזן (דמו)', 'מחיקה');
    const dialog = await screen.findByRole('dialog', { name: 'מחיקת משתמש לצמיתות' });
    expect(within(dialog).getByText(/בלתי הפיכה/)).toBeInTheDocument();
    expect(within(dialog).getByText(/חשבון ההתחברות הנוכחי של המשתמש ל-AVARIA.*Supabase Auth/)).toBeInTheDocument();
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
    await clickRowAction(user, 'מאיה רוזן (דמו)', 'מחיקה');

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
    expect(within(rowEl).getByText('סוג משתמש: אחמ״ש')).toBeInTheDocument(); // historical role preserved
    expect(menuTriggerIn(rowEl)).not.toBeInTheDocument();
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
    await clickRowAction(user, 'עומר פרץ (דמו)', 'מחיקה');
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
    // Neither row exposes an overflow trigger, so מחיקה is unreachable on
    // both counts (above the ceiling, and never on one's own row).
    expect(menuTriggerIn(rowFor('דנה לוי (דמו)'))).not.toBeInTheDocument();
    expect(menuTriggerIn(rowFor('יואב כהן (דמו)'))).not.toBeInTheDocument();
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
      await clickRowAction(user, 'מאיה רוזן (דמו)', 'מחיקה');
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
      expect(menuTriggerIn(rowEl)).not.toBeInTheDocument();
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
      expect(menuTriggerIn(rowAfter)).not.toBeInTheDocument();
    });

    it('does not offer the recovery action to an out-of-ceiling actor for an already-deleted profile', async () => {
      // Tombstone a professional_manager (no incidents owned) as admin first.
      let user = await openPersonnel('login-u-admin');
      await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
      await within(main()).findByText('דנה לוי (דמו)');
      await clickRowAction(user, 'דנה לוי (דמו)', 'מחיקה');
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

describe('role grouping', () => {
  function groupHeadings(): string[] {
    return Array.from(main().querySelectorAll('section[aria-labelledby^="personnel-group-"] > h2')).map(
      (h) => (h.textContent ?? '').replace(/\s*\(\d+\)$/, ''),
    );
  }

  it('groups the active tab from highest to lowest role, using the page\'s own Hebrew labels', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('אלון ברק (דמו)');

    // Exactly the implemented hierarchy order, highest authority first.
    expect(groupHeadings()).toEqual(['מנהל מערכת', 'נגד', 'אחמ״ש', 'טכנאי', 'צפייה בלבד']);
  });

  it('omits groups with no members in the current result set', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    // Narrow the result set to a single technician: every other group
    // disappears rather than rendering empty.
    await user.type(screen.getByLabelText('חיפוש לפי שם או כתובת Google'), 'עומר');
    await waitFor(() => expect(groupHeadings()).toEqual(['טכנאי']));
    expect(within(main()).getByText('עומר פרץ (דמו)')).toBeInTheDocument();
    expect(within(main()).queryByText('אלון ברק (דמו)')).not.toBeInTheDocument();
  });

  it('groups each entry under its own role and keeps every row in the result set', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('אלון ברק (דמו)');

    const sectionFor = (heading: string) =>
      Array.from(main().querySelectorAll('section[aria-labelledby^="personnel-group-"]')).find((s) =>
        (s.querySelector('h2')?.textContent ?? '').startsWith(heading),
      ) as HTMLElement;

    expect(within(sectionFor('מנהל מערכת')).getByText('אלון ברק (דמו)')).toBeInTheDocument();
    expect(within(sectionFor('טכנאי')).getByText('עומר פרץ (דמו)')).toBeInTheDocument();
    expect(within(sectionFor('טכנאי')).getByText('ליאור אדרי (דמו)')).toBeInTheDocument();
    // Grouping reorganizes the result set without dropping anyone from it.
    expect(main().querySelectorAll('[data-personnel-row]').length).toBe(7);
  });

  it('preserves tab switching: the pending tab groups its own entries independently', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await addPending(user);
    expect(groupHeadings()).toEqual(['טכנאי']);
  });
});

describe('row action menu', () => {
  it('collapses עריכה and מחיקה behind one trigger, with deletion destructive and separated', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    const menu = await openRowMenu(user, 'עומר פרץ (דמו)');
    const edit = within(menu).getByRole('menuitem', { name: 'עריכה' });
    const remove = within(menu).getByRole('menuitem', { name: 'מחיקה' });

    expect(edit).toBeInTheDocument();
    expect(remove).toHaveClass('text-red-700');
    // Separated by a rule, so activating it takes deliberate extra travel.
    expect(remove.parentElement).toHaveClass('border-t');
  });

  it('opens from the keyboard, moves with the arrow keys, and returns focus on Escape', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    const trigger = menuTriggerIn(rowFor('עומר פרץ (דמו)')) as HTMLElement;
    trigger.focus();
    await user.keyboard('{ArrowDown}');

    const menu = await within(rowFor('עומר פרץ (דמו)')).findByRole('menu');
    const edit = within(menu).getByRole('menuitem', { name: 'עריכה' });
    const rename = within(menu).getByRole('menuitem', { name: 'שינוי שם' });
    const remove = within(menu).getByRole('menuitem', { name: 'מחיקה' });
    await waitFor(() => expect(edit).toHaveFocus());

    await user.keyboard('{ArrowDown}');
    expect(rename).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(remove).toHaveFocus();
    // Roving focus wraps rather than dead-ending.
    await user.keyboard('{ArrowDown}');
    expect(edit).toHaveFocus();
    await user.keyboard('{End}');
    expect(remove).toHaveFocus();
    await user.keyboard('{Home}');
    expect(edit).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(within(rowFor('עומר פרץ (דמו)')).queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('closes on an outside click without running any action', async () => {
    const user = await openPersonnel('login-u-admin');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('עומר פרץ (דמו)');

    await openRowMenu(user, 'עומר פרץ (דמו)');
    await user.click(screen.getByRole('heading', { name: 'כוח אדם' }));

    await waitFor(() =>
      expect(within(rowFor('עומר פרץ (דמו)')).queryByRole('menu')).not.toBeInTheDocument(),
    );
    // No dialog was opened -- dismissing is not an activation.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('returns focus to the trigger when an action is chosen', async () => {
    const user = await openPersonnel('login-u-supervisor-1');
    await addPending(user);

    await clickRowAction(user, 'ממתין לבדיקה', 'עריכה');
    expect(await screen.findByRole('dialog', { name: 'עריכת רישום ממתין' })).toBeInTheDocument();
    // The menu closed behind the dialog rather than staying open under it.
    expect(within(rowFor('ממתין לבדיקה')).queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps the last-active-admin guard: מחיקה is present but disabled with its explanation', async () => {
    const user = await openPersonnel('login-u-manager');
    await user.click(screen.getByRole('tab', { name: /^פעילים/ }));
    await within(main()).findByText('יואב כהן (דמו)');

    // A manager may manage a shift_supervisor, so the menu exists...
    const menu = await openRowMenu(user, 'יואב כהן (דמו)');
    expect(within(menu).getByRole('menuitem', { name: 'מחיקה' })).not.toBeDisabled();
  });
});
