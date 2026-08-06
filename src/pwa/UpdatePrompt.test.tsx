import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const update = vi.fn();
const dismiss = vi.fn();
let needRefresh = false;

vi.mock('./usePwaUpdate', () => ({
  usePwaUpdate: () => ({ needRefresh, update, dismiss }),
}));

import { UpdatePrompt } from './UpdatePrompt';

describe('UpdatePrompt', () => {
  beforeEach(() => {
    needRefresh = false;
    update.mockClear();
    dismiss.mockClear();
  });

  it('renders nothing when no new version is available', () => {
    const { container } = render(<UpdatePrompt />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the AVARIA-styled Hebrew notice once a new version is ready', () => {
    needRefresh = true;
    render(<UpdatePrompt />);
    expect(screen.getByText('גרסה חדשה של AVARIA זמינה')).toBeInTheDocument();
    expect(
      screen.getByText('כדי לקבל את השינויים האחרונים יש לרענן את המערכת.'),
    ).toBeInTheDocument();
  });

  it('"עדכון עכשיו" invokes the Service Worker update flow', async () => {
    needRefresh = true;
    render(<UpdatePrompt />);
    await userEvent.click(screen.getByRole('button', { name: 'עדכון עכשיו' }));
    expect(update).toHaveBeenCalledTimes(1);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('"מאוחר יותר" dismisses the notice without updating or reloading', async () => {
    needRefresh = true;
    render(<UpdatePrompt />);
    await userEvent.click(screen.getByRole('button', { name: 'מאוחר יותר' }));
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
