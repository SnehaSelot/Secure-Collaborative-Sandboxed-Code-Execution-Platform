import { useEffect, useState } from 'react';
import { getLanguages } from '../api/execution';
import { FALLBACK_LANGUAGES } from '../config/constants';

interface UseLanguagesResult {
  languages: string[];
  loading: boolean;
  /** True when the list shown is the local fallback, not real backend data. */
  isFallback: boolean;
}

/**
 * BACKEND INTEGRATION:
 * Endpoint: GET /languages
 * Status: Available
 * Request: None
 * Response: { languages: string[] }
 * TODO: Keep this function isolated so the endpoint can be changed later.
 *
 * Uses FALLBACK_LANGUAGES only if the request fails — per project rule,
 * the hardcoded list is never shown when the backend successfully
 * responds, even if the backend's list differs from our fallback.
 */
export function useLanguages(): UseLanguagesResult {
  const [languages, setLanguages] = useState<string[]>([...FALLBACK_LANGUAGES]);
  const [loading, setLoading] = useState(true);
  const [isFallback, setIsFallback] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const data = await getLanguages();
        if (!cancelled && data.languages.length > 0) {
          setLanguages(data.languages);
          setIsFallback(false);
        }
      } catch {
        if (!cancelled) {
          setLanguages([...FALLBACK_LANGUAGES]);
          setIsFallback(true);
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

  return { languages, loading, isFallback };
}