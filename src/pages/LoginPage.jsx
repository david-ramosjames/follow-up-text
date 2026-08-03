import { useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import BrandBar from "../components/BrandBar";
import { useSession } from "../components/Session";
import { signInWithPassword } from "../lib/api";

const ERRORS = {
  not_allowed: "That account is not on the access list, or does not have dashboard access.",
  wrong_domain: "That Google account is outside the firm's domain.",
  unverified: "That Google address has not been verified, so it cannot be used to sign in.",
  cancelled: "Sign-in was cancelled.",
  state: "That sign-in link expired. Try again.",
  google: "Google refused the sign-in. Check the client ID, secret and redirect URI.",
  slack: "Slack refused the sign-in. Check the client ID and secret.",
  google_not_configured: "Google sign-in is not configured on this deployment.",
  slack_not_configured: "Slack sign-in is not configured on this deployment.",
};

function GoogleMark() {
  return (
    <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.81.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

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
  const rejectedEmail = params.get("email");
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

  const hasSso = session.googleSignInAvailable || session.slackSignInAvailable;

  return (
    <main className="login-page">
      <div className="login-panel">
        <BrandBar strap="Client follow-ups" />
        <h1>Sign in</h1>

        {urlError && (
          <p className="form-error">
            {ERRORS[urlError] ?? "Sign-in did not work."}
            {rejectedEmail && (
              <> You signed in as <strong>{rejectedEmail}</strong> — an administrator can add that
                address under Access.</>
            )}
            {rejectedSlackId && (
              <> Your Slack ID is <code>{rejectedSlackId}</code> — an administrator can add it
                under Access.</>
            )}
          </p>
        )}

        {session.unreachable && (
          <p className="form-error">The server is not responding. Check that it is running.</p>
        )}

        <div className="login-buttons">
          {session.googleSignInAvailable && (
            <a className="button sso" href="/auth/google/start">
              <GoogleMark /> Continue with Google
            </a>
          )}
          {session.slackSignInAvailable && (
            <a className="button sso" href="/auth/slack/start">Continue with Slack</a>
          )}
        </div>

        {hasSso && session.passwordSignInAvailable && <p className="login-or">or</p>}

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

        {!hasSso && !session.passwordSignInAvailable && (
          <p className="form-error">
            No sign-in method is configured. Set <code>GOOGLE_CLIENT_ID</code> and
            {" "}<code>GOOGLE_CLIENT_SECRET</code> for Google sign-in, or <code>ADMIN_PASSWORD</code>
            {" "}to get in the first time.
          </p>
        )}

        {!session.hasAdmins && session.passwordSignInAvailable && (
          <p className="login-note">
            Nobody is on the access list yet. Sign in with the password, then add people under
            <strong> Access</strong> with their work email so they can sign in with Google.
          </p>
        )}

        <p className="login-note">
          This shows client phone numbers and message history, so access is limited to the people on
          the access list. Paralegals start and stop follow-ups from Slack and never need to sign in
          here.
        </p>
      </div>
    </main>
  );
}
