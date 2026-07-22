import { useEffect, useState } from "react";

import { apiRequest } from "../api/client";

interface ApiState<T> {
  data: T | null;
  error: string;
  loading: boolean;
}

export function useApi<T>(path: string): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    error: "",
    loading: true,
  });

  useEffect(() => {
    const controller = new AbortController();
    apiRequest<T>(path, { signal: controller.signal })
      .then((data) => setState({ data, error: "", loading: false }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          data: null,
          error: error instanceof Error ? error.message : "The request failed.",
          loading: false,
        });
      });
    return () => controller.abort();
  }, [path]);

  return state;
}
