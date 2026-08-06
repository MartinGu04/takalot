// Thin wrapper around vite-plugin-pwa's generated register hook, narrowed
// to exactly what UpdatePrompt needs. Kept in its own module so the
// 'virtual:pwa-register/react' import (only resolvable through the Vite
// plugin) has a single call site the rest of the app -- and tests -- never
// have to know about.
import { useRegisterSW } from 'virtual:pwa-register/react';

export interface PwaUpdateState {
  /** A new Service Worker has installed and is waiting to take over. */
  needRefresh: boolean;
  /** Sends skip-waiting to the new worker; the page reloads once it takes control. */
  update: () => void;
  /** Hides the notice without updating -- no reload happens. */
  dismiss: () => void;
}

export function usePwaUpdate(): PwaUpdateState {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  return {
    needRefresh,
    update: () => {
      void updateServiceWorker(true);
    },
    dismiss: () => setNeedRefresh(false),
  };
}
