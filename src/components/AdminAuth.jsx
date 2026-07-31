import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { isSupabaseConfigured, supabase } from "../lib/supabase";

const AdminAuthContext = createContext(null);

export function AdminAuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [authReady, setAuthReady] = useState(!isSupabaseConfigured);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminReady, setAdminReady] = useState(!isSupabaseConfigured);

  useEffect(() => {
    if (!supabase) return undefined;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setAuthReady(true);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  // Signing in with Google only proves identity. Whether this account may see
  // client phone numbers is a separate question the database answers.
  useEffect(() => {
    let active = true;
    if (!supabase || !session) {
      setIsAdmin(false);
      setAdminReady(true);
      return undefined;
    }
    setAdminReady(false);
    supabase.rpc("is_admin").then(({ data, error }) => {
      if (!active) return;
      setIsAdmin(!error && data === true);
      setAdminReady(true);
    });
    return () => { active = false; };
  }, [session]);

  const value = useMemo(() => ({
    configured: isSupabaseConfigured,
    session,
    user: session?.user || null,
    isAdmin,
    loading: !authReady || !adminReady,
    signIn: (redirectPath = "/") => supabase?.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}${redirectPath}` },
    }),
    signOut: () => supabase?.auth.signOut(),
  }), [adminReady, authReady, isAdmin, session]);

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  return useContext(AdminAuthContext);
}
