import { MessageSquareText } from "lucide-react";
import { Navigate, useLocation } from "react-router-dom";
import { useAdminAuth } from "../components/AdminAuth";

export default function LoginPage() {
  const auth = useAdminAuth();
  const location = useLocation();
  const from = location.state?.from || "/";

  if (auth.loading) return <main className="page-state">Checking access...</main>;
  if (auth.session && auth.isAdmin) return <Navigate to={from} replace />;

  return (
    <main className="login-page">
      <div className="login-panel">
        <p className="eyebrow"><MessageSquareText size={14} /> Client follow-ups</p>
        <h1>Sign in</h1>

        {!auth.configured && (
          <p className="form-error">
            Supabase is not connected. Copy <code>.env.example</code> to <code>.env.local</code>,
            fill in the project URL and anon key, and restart the dev server.
          </p>
        )}

        {auth.configured && auth.session && !auth.isAdmin && (
          <p className="form-error">
            {auth.user?.email} is signed in but is not on the administrator list. Add the address
            to <code>admin_users</code> in Supabase, then reload.
          </p>
        )}

        {auth.configured && (
          <button type="button" className="primary" onClick={() => auth.signIn(from)}>
            Continue with Google
          </button>
        )}

        <p className="login-note">
          This area shows client phone numbers and message history, so access is limited to the
          administrator list in the database. Paralegals start and stop follow-ups from Slack and
          never need to sign in here.
        </p>
      </div>
    </main>
  );
}
