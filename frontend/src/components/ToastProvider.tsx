import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface Toast {
  id: number;
  message: string;
  tone: "success" | "error";
}

interface ToastApi {
  notify: (message: string, tone?: Toast["tone"]) => void;
}

const ToastContext = createContext<ToastApi>({ notify: () => {} });

/** Transient confirmations for actions that would otherwise fail silently. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const notify = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = (nextId.current += 1);
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 5000);
  }, []);

  const api = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone === "error" ? "toast-error" : ""}`}>
            <span aria-hidden="true">{toast.tone === "error" ? "!" : "✓"}</span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
