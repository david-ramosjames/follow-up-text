import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useSession } from "./Session";

const FirmContext = createContext(null);
const STORAGE_KEY = "followup_firm_id";

export function FirmProvider({ children }) {
  const session = useSession();
  const [firms, setFirms] = useState([]);
  const [current, setCurrent] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!session?.signedIn) {
      setFirms([]);
      setCurrent(null);
      setLoading(false);
      return;
    }
    try {
      const data = await api.get("/firms");
      setFirms(data.firms ?? []);
      const stored = localStorage.getItem(STORAGE_KEY);
      const match = data.firms?.find((firm) => firm.id === stored) || data.current || data.firms?.[0] || null;
      setCurrent(match);
      if (match) localStorage.setItem(STORAGE_KEY, match.id);
    } catch {
      setFirms([]);
    } finally {
      setLoading(false);
    }
  }, [session?.signedIn]);

  useEffect(() => { refresh(); }, [refresh]);

  const switchFirm = useCallback((id) => {
    localStorage.setItem(STORAGE_KEY, id);
    window.location.reload();
  }, []);

  const value = useMemo(() => ({
    firms, current, loading, refresh, switchFirm,
  }), [firms, current, loading, refresh, switchFirm]);

  return <FirmContext.Provider value={value}>{children}</FirmContext.Provider>;
}

export function useFirm() {
  return useContext(FirmContext);
}
