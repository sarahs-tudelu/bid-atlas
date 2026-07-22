import { useCallback, useEffect, useState } from "react";

import { apiRequest } from "../api/client";

export interface ApiState<T> {
  data: T | null;
  error: string;
  /** True only while the first payload for this hook is still in flight. */
  loading: boolean;
  /** True while a follow-up request runs and the previous payload is still on screen. */
  refreshing: boolean;
  refetch: () => void;
}

interface Settled<T> {
  key: string;
  data: T | null;
  error: string;
}

/**
 * Fetches `path` and keeps the previous payload visible while the next one loads,
 * so paging and filtering never blank the page out from under the reader.
 *
 * Progress is derived by comparing the settled request key against the current
 * one; nothing is assigned during render or synchronously inside the effect.
 */
export function useApi<T>(path: string): ApiState<T> {
  const [reloadToken, setReloadToken] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const key = `${reloadToken}:${path}`;

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<T>(path, { signal: controller.signal })
      .then((data) => setSettled({ key, data, error: "" }))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setSettled({
          key,
          data: null,
          error: cause instanceof Error ? cause.message : "The request failed.",
        });
      });
    return () => controller.abort();
  }, [key, path]);

  const refetch = useCallback(() => setReloadToken((token) => token + 1), []);

  const pending = settled?.key !== key;
  const data = settled?.data ?? null;

  return {
    data,
    error: pending ? "" : (settled?.error ?? ""),
    loading: pending && data === null,
    refreshing: pending && data !== null,
    refetch,
  };
}
