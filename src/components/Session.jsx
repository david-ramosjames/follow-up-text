import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { fetchSession, signOut as apiSignOut } from "../lib/api";

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, signedIn: false, user: null });

  const refresh = useCallback(async () => {
    try {
      const data = await fetchSession();
      setState({ loading: false, ...data });
    } catch {
      setState({ loading: false, signedIn: false, user: null, unreachable: true });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const value = useMemo(() => ({
    ...state,
    refresh,
    signOut: async () => {
      await apiSignOut();
      await refresh();
    },
  }), [state, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}

export function RequireSession({ children }) {
  const session = useSession();
  const location = useLocation();
  if (session.loading) return <main className="page-state">Checking access…</main>;
  if (!session.signedIn) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
