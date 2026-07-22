import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError, apiRequest } from "../api/client";
import type { AuthUser } from "../types";


interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  error: string;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<{ user: AuthUser }>("/api/auth/me")
      .then((response) => {
        if (active) setUser(response.user);
      })
      .catch((cause: unknown) => {
        if (!active || (cause instanceof ApiError && cause.status === 401)) return;
        setError(cause instanceof Error ? cause.message : "Authentication could not be checked.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      error,
      logout: async () => {
        await apiRequest<void>("/api/auth/logout", { method: "POST" });
        setUser(null);
      },
    }),
    [error, loading, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
