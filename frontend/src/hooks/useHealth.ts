import { useEffect, useState } from 'react';
import { getHealth } from '../api/execution';
import { HEALTH_POLL_INTERVAL_MS } from '../config/constants';

export type BackendConnectionStatus = 'checking' | 'online' | 'offline';

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /health
 * Status: Available
 * Request: None
 * Response: { status: string }
 * TODO: Keep this function isolated so the endpoint can be changed later.
 *
 * Polls on an interval so the header's connection indicator reflects
 * reality even if the backend goes down mid-session, not just on load.
 */
export function useHealth(): BackendConnectionStatus {
  const [status, setStatus] = useState<BackendConnectionStatus>('checking');

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const data = await getHealth();
        if (!cancelled) {
          setStatus(data.status === 'ok' ? 'online' : 'offline');
        }
      } catch {
        if (!cancelled) {
          setStatus('offline');
        }
      }
    }

    check();
    const interval = setInterval(check, HEALTH_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return status;
}