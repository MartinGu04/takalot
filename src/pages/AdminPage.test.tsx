import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../App';

beforeEach(() => {
  localStorage.clear();
  window.history.pushState({}, '', '/');
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
    expect(within(systemCard).getByRole('button', { name: `הזזת ${systemName} למעלה` })).toBeEnabled();
    expect(within(systemCard).getByRole('button', { name: `הזזת ${systemName} למטה` })).toBeDisabled();

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

    await user.click(within(systemCard).getByRole('button', { name: 'מחיקה' }));
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
    await user.click(within(cardNamed('אתר 1')).getByRole('button', { name: 'מחיקה' }));
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
