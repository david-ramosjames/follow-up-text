import { MessageSquareText } from "lucide-react";
import { useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useSession } from "../components/Session";
import { signInWithPassword } from "../lib/api";

const ERRORS = {
  not_allowed: "That Slack account is not on the operator list, or does not have dashboard access.",
  cancelled: "Sign-in was cancelled.",
  state: "That sign-in link expired. Try again.",
  slack: "Slack refused the sign-in. Check the client ID and secret.",
};

export default function LoginPage() {
  const session = useSession();
  const location = useLocation();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const from = location.state?.from || "/";
  if (session.loading) return <main className="page-state">Checking access…</main>;
  if (session.signedIn) return <Navigate to={from} replace />;

  const urlError = params.get("error");
  const rejectedSlackId = params.get("slack_id");

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await signInWithPassword(password);
      await session.refresh();
    } catch (signInError) {
      setError(signInError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page">
      <div className="login-panel">
        <p className="eyebrow"><MessageSquareText size={14} /> Client follow-ups</p>
        <h1>Sign in</h1>

        {urlError && (
          <p className="form-error">
            {ERRORS[urlError] ?? "Sign-in did not work."}
            {rejectedSlackId && <> Your Slack ID is <code>{rejectedSlackId}</code> — an administrator can add it under Operators.</>}
          </p>
        )}

        {session.unreachable && (
          <p className="form-error">The server is not responding. Check that it is running.</p>
        )}

        {session.slackSignInAvailable && (
          <a className="button primary" href="/auth/slack/start">Continue with Slack</a>
        )}

        {session.slackSignInAvailable && session.passwordSignInAvailable && (
          <p className="login-or">or</p>
        )}

        {session.passwordSignInAvailable && (
          <form onSubmit={submit} className="login-form">
            <label>
              <span>Administrator password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button type="submit" className="button primary" disabled={busy || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        {error && <p className="form-error">{error}</p>}

        {!session.slackSignInAvailable && !session.passwordSignInAvailable && (
          <p className="form-error">
            No sign-in method is configured. Set <code>ADMIN_PASSWORD</code> to get in the first
            time, or <code>SLACK_CLIENT_ID</code> and <code>SLACK_CLIENT_SECRET</code> for
            Sign in with Slack.
          </p>
        )}

        {!session.hasAdmins && session.passwordSignInAvailable && (
          <p className="login-note">
            Nobody has dashboard access yet. Sign in with the password, then add yourself under
            Operators with <strong>dashboard access</strong> ticked so you can sign in with Slack
            from then on.
          </p>
        )}

        <p className="login-note">
          This shows client phone numbers and message history, so access is limited to people on
          the operator list. Paralegals start and stop follow-ups from Slack and never need to
          sign in here.
        </p>
      </div>
    </main>
  );
}
