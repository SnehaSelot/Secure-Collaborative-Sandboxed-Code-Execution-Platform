import { useEffect, useState } from 'react';
import { getLimits } from '../api/execution';
import type { LimitsResponse } from '../api/types';

interface UseLimitsResult {
  limits: LimitsResponse | null;
  loading: boolean;
  error: string | null;
}

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /limits
 * Status: Available
 * Request: None
 * Response: { timeout_seconds, memory_limit, max_processes, max_open_files,
 *              max_file_size_bytes, max_output_chars }
 * TODO: Keep this function isolated so the endpoint can be changed later.
 *
 * No fallback data here (unlike useLanguages) — these are real sandbox
 * constraints, not something safe to guess at if the backend is down.
 * Consumers should hide limit-dependent UI when `limits` is null.
 */
export function useLimits(): UseLimitsResult {
  const [limits, setLimits] = useState<LimitsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await getLimits();
        if (!cancelled) {
          setLimits(data);
        }
      } catch {
        if (!cancelled) {
          setError('Sandbox limits unavailable.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { limits, loading, error };
}