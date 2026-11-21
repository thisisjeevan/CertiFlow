import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, apiRequest } from './api';

const initial = { workflow: 0, certificates: 0, notifications: 0 };
const LiveVersions = createContext(initial);

export const useLiveVersion = (scope: keyof typeof initial) => useContext(LiveVersions)[scope];

export function LiveUpdates({ children, onSessionExpired }: { children: ReactNode; onSessionExpired: () => void }) {
  const [versions, setVersions] = useState(initial);

  useEffect(() => {
    const controller = new AbortController();
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout>;

    function connect() {
      source = new EventSource('/api/events');
      source.addEventListener('sync', (event: MessageEvent<string>) => {
        const changed = new Set<string>(JSON.parse(event.data) as string[]);
        setVersions((current) => ({
          workflow: current.workflow + Number(changed.has('workflow')),
          certificates: current.certificates + Number(changed.has('certificates')),
          notifications: current.notifications + Number(changed.has('notifications')),
        }));
      });
      source.addEventListener('session-ended', () => {
        source?.close();
        onSessionExpired();
      });
      source.onerror = () => {
        // Browsers reconnect transient errors. Restart closed streams after checking the session.
        if (source?.readyState !== EventSource.CLOSED) return;
        void apiRequest('/api/auth/me', { signal: controller.signal }).catch((error: unknown) => {
          if (error instanceof ApiError && error.status === 401) onSessionExpired();
        }).finally(() => {
          if (!controller.signal.aborted) retry = setTimeout(connect, 3_000);
        });
      };
    }

    connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
      source?.close();
    };
  }, [onSessionExpired]);

  return <LiveVersions.Provider value={versions}>{children}</LiveVersions.Provider>;
}
