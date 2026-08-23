// Phase 4 -> Phase 5 rollout gate: the Push section is hidden entirely until
// a valid VITE_VAPID_PUBLIC_KEY is configured (see PushSubscriptionSettings.tsx).
// usePushSubscription itself is owned by the caller (NotificationsMenu, so
// its auto-restore effect can run independent of this dialog's open state --
// see that component) and passed in as the `push` prop here; its own state
// machine (including 'configuration-unavailable') is already covered by
// src/push/usePushSubscription.test.ts, so this file only proves the outer
// gate.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { UsePushSubscriptionResult } from '../push/usePushSubscription';

const VALID_KEY = 'BIulvpvnacETZPcbRM1eBA-EgswBwrkev3pqSELJwHknIjc71adxWApy98SMyOrvgrLDJj2u9-DM0Vw_euvkCuM';

let configuredVapidKey: string | null = null;

vi.mock('../push/vapidKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../push/vapidKey')>();
  return { ...actual, getConfiguredVapidPublicKey: () => configuredVapidKey };
});

import { PushSubscriptionSettings } from './PushSubscriptionSettings';

const push: UsePushSubscriptionResult = {
  state: 'not-subscribed',
  otherDeviceCount: 0,
  updatePending: false,
  enable: vi.fn(),
  disable: vi.fn(),
  disconnectAll: vi.fn(),
};

describe('PushSubscriptionSettings: Phase 4 -> Phase 5 rollout gate', () => {
  it('1. renders nothing when VITE_VAPID_PUBLIC_KEY is missing', () => {
    configuredVapidKey = null;
    const { container } = render(<PushSubscriptionSettings push={push} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('התראות במכשיר')).not.toBeInTheDocument();
  });

  it('2. renders nothing when the configured key is invalid (malformed/wrong shape)', () => {
    configuredVapidKey = 'not-a-real-key';
    const { container } = render(<PushSubscriptionSettings push={push} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('התראות במכשיר')).not.toBeInTheDocument();
  });

  it('3. renders normally when the configured key is valid', () => {
    configuredVapidKey = VALID_KEY;
    render(<PushSubscriptionSettings push={push} />);
    expect(screen.getByText('התראות במכשיר')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'הפעל התראות במכשיר זה' })).toBeInTheDocument();
  });
});
