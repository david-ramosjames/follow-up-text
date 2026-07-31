import crypto from "node:crypto";
import express from "express";
import { one, query } from "./db.js";

// Who can sign in to the dashboard is a single explicit list — the same
// followup_operators table the Slack side uses. A person may be identified by a
// Slack ID, an email address, or both:
//
//   Google sign-in  matches on email
//   Slack sign-in   matches on Slack member ID
//   either way      the person must have can_admin and is_active
//
// ADMIN_PASSWORD is a deliberate break-glass: somebody has to be able to get in
// and add the first person before anybody is on the list, and to get back in if
// an identity provider is misconfigured.

const COOKIE = "followup_session";
const STATE_COOKIE = "followup_oauth_state";
const SESSION_DAYS = 14;

export function googleConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function slackSignInConfigured() {
  return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

export function passwordConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

function publicUrl(req) {
  const configured = process.env.PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  // Railway terminates TLS upstream, so trust the forwarded protocol.
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

// Secure cookies are required over https and are silently dropped by the browser
// over plain http, so this is derived from the deployed URL rather than asking
// for NODE_ENV. On Railway, NODE_ENV is applied at build time as well as run
// time, where setting it to production can make npm skip the dev dependencies
// the front-end build needs — a footgun worth not having.
const secureCookies = () => process.env.NODE_ENV === "production"
  || (process.env.PUBLIC_URL ?? "").startsWith("https://");

function setCookie(res, name, value, maxAgeSeconds) {
  res.append("Set-Cookie", `${name}=${value}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`
    + (secureCookies() ? "; Secure" : ""));
}

function clearCookie(res, name) {
  res.append("Set-Cookie", `${name}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
    + (secureCookies() ? "; Secure" : ""));
}

// Minimal cookie parsing, so the app carries no extra dependency for it.
export function cookieParser(req, res, next) {
  const header = req.get("cookie");
  req.cookies = {};
  if (header) {
    for (const part of header.split(";")) {
      const index = part.indexOf("=");
      if (index === -1) continue;
      req.cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  next();
}

async function createSession({ userId, provider, displayName, email, slackUserId }) {
  const id = crypto.randomBytes(32).toString("base64url");
  await query(
    `insert into app_sessions
       (id, user_id, provider, slack_user_id, display_name, email, is_supervisor, expires_at)
     values ($1, $2, $3, $4, $5, $6, false, now() + ($7 || ' days')::interval)`,
    [id, userId ?? null, provider, slackUserId ?? null, displayName ?? null, email ?? null, String(SESSION_DAYS)],
  );
  return id;
}

// Permissions are read from the person's current row on every request rather
// than from whatever was true when they signed in, so revoking access takes
// effect immediately instead of whenever a two-week cookie expires.
export async function readSession(req) {
  const id = req.cookies?.[COOKIE];
  if (!id) return null;

  const session = await one(
    `select s.id, s.provider, s.user_id,
            coalesce(o.display_name, s.display_name) as display_name,
            coalesce(o.email, s.email) as email,
            coalesce(o.slack_user_id, s.slack_user_id) as slack_user_id,
            coalesce(o.is_supervisor, true) as is_supervisor,
            o.id as person_id, o.can_admin, o.is_active
     from app_sessions s
     left join followup_operators o on o.id = s.user_id
     where s.id = $1 and s.expires_at > now()`,
    [id],
  );
  if (!session) return null;

  // The password session has no person behind it; that is the point of it.
  if (session.provider !== "password") {
    if (!session.person_id || !session.can_admin || !session.is_active) {
      await query("delete from app_sessions where id = $1", [id]).catch(() => {});
      return null;
    }
  }

  return session;
}

export function requireSession(handler) {
  return async (req, res, next) => {
    try {
      const session = await readSession(req);
      if (!session) return res.status(401).json({ error: "Not signed in." });
      req.session = session;
      return await handler(req, res, next);
    } catch (error) {
      return next(error);
    }
  };
}

async function findPerson({ email, slackUserId }) {
  if (email) {
    return one(
      `select id, display_name, email, slack_user_id, is_supervisor, can_admin, is_active
       from followup_operators where email = $1`,
      [String(email).trim().toLowerCase()],
    );
  }
  if (slackUserId) {
    return one(
      `select id, display_name, email, slack_user_id, is_supervisor, can_admin, is_active
       from followup_operators where slack_user_id = $1`,
      [slackUserId],
    );
  }
  return null;
}

// A signed OAuth state cookie is what stops somebody handing the user a crafted
// callback URL and logging them into an account they did not choose.
function issueState(res) {
  const state = crypto.randomBytes(16).toString("base64url");
  setCookie(res, STATE_COOKIE, state, 600);
  return state;
}

function stateMatches(req) {
  const provided = req.query.state;
  const expected = req.cookies?.[STATE_COOKIE];
  return Boolean(provided) && Boolean(expected)
    && provided.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(String(provided)), Buffer.from(expected));
}

// The token endpoints are called server-to-server over TLS with our own client
// secret, so the id_token that comes back is trusted without re-verifying its
// signature. Its claims are still read defensively.
function decodeIdToken(idToken) {
  const payload = String(idToken ?? "").split(".")[1];
  if (!payload) throw new Error("No id_token in the response.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

export const authRouter = express.Router();

authRouter.get("/me", async (req, res) => {
  const session = await readSession(req);
  const admins = await one(
    "select count(*)::int as count from followup_operators where can_admin and is_active",
  );
  res.json({
    signedIn: Boolean(session),
    user: session
      ? {
        displayName: session.display_name,
        email: session.email,
        slackUserId: session.slack_user_id,
        isSupervisor: session.is_supervisor,
        provider: session.provider,
      }
      : null,
    googleSignInAvailable: googleConfigured(),
    slackSignInAvailable: slackSignInConfigured(),
    passwordSignInAvailable: passwordConfigured(),
    // Lets the sign-in page explain the first-run state rather than just
    // refusing everybody with no hint about why.
    hasAdmins: (admins?.count ?? 0) > 0,
  });
});

/* ------------------------------------------------------------------ Google */

authRouter.get("/google/start", (req, res) => {
  if (!googleConfigured()) return res.redirect("/login?error=google_not_configured");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${publicUrl(req)}/auth/google/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", issueState(res));
  url.searchParams.set("access_type", "online");
  // Always show the chooser: shared machines in an office are the norm, and
  // silently reusing whichever Google account is already signed in is a
  // genuinely bad surprise when the screen shows client phone numbers.
  url.searchParams.set("prompt", "select_account");
  if (process.env.GOOGLE_HOSTED_DOMAIN) url.searchParams.set("hd", process.env.GOOGLE_HOSTED_DOMAIN);

  res.redirect(url.toString());
});

authRouter.get("/google/callback", async (req, res, next) => {
  try {
    if (!googleConfigured()) return res.redirect("/login?error=google_not_configured");
    clearCookie(res, STATE_COOKIE);
    if (req.query.error || !req.query.code) return res.redirect("/login?error=cancelled");
    if (!stateMatches(req)) return res.redirect("/login?error=state");

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code: String(req.query.code),
        grant_type: "authorization_code",
        redirect_uri: `${publicUrl(req)}/auth/google/callback`,
      }),
    });
    const token = await response.json();
    if (!response.ok || !token.id_token) {
      console.error("Google token exchange failed", token.error_description ?? token.error);
      return res.redirect("/login?error=google");
    }

    const claims = decodeIdToken(token.id_token);

    // An unverified address proves nothing about who is holding it, and this
    // list is keyed on email.
    if (claims.email_verified === false) return res.redirect("/login?error=unverified");

    const email = String(claims.email ?? "").trim().toLowerCase();
    if (!email) return res.redirect("/login?error=google");

    if (process.env.GOOGLE_HOSTED_DOMAIN && claims.hd !== process.env.GOOGLE_HOSTED_DOMAIN) {
      return res.redirect(`/login?error=wrong_domain&email=${encodeURIComponent(email)}`);
    }

    const person = await findPerson({ email });
    if (!person?.can_admin || !person.is_active) {
      return res.redirect(`/login?error=not_allowed&email=${encodeURIComponent(email)}`);
    }

    await query(
      `update followup_operators
       set last_seen_at = now(), display_name = coalesce(display_name, $2)
       where id = $1`,
      [person.id, claims.name ?? null],
    );

    const id = await createSession({
      userId: person.id,
      provider: "google",
      displayName: person.display_name ?? claims.name ?? email,
      email,
      slackUserId: person.slack_user_id,
    });
    setCookie(res, COOKIE, id, SESSION_DAYS * 24 * 60 * 60);
    return res.redirect("/");
  } catch (error) {
    return next(error);
  }
});

/* ------------------------------------------------------------------- Slack */

authRouter.get("/slack/start", (req, res) => {
  if (!slackSignInConfigured()) return res.redirect("/login?error=slack_not_configured");

  const url = new URL("https://slack.com/openid/connect/authorize");
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${publicUrl(req)}/auth/slack/callback`);
  url.searchParams.set("state", issueState(res));
  if (process.env.SLACK_TEAM_ID) url.searchParams.set("team", process.env.SLACK_TEAM_ID);

  res.redirect(url.toString());
});

authRouter.get("/slack/callback", async (req, res, next) => {
  try {
    if (!slackSignInConfigured()) return res.redirect("/login?error=slack_not_configured");
    clearCookie(res, STATE_COOKIE);
    if (req.query.error || !req.query.code) return res.redirect("/login?error=cancelled");
    if (!stateMatches(req)) return res.redirect("/login?error=state");

    const response = await fetch("https://slack.com/api/openid.connect.token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code: String(req.query.code),
        redirect_uri: `${publicUrl(req)}/auth/slack/callback`,
      }),
    });
    const token = await response.json();
    if (!token.ok) {
      console.error("Slack token exchange failed", token.error);
      return res.redirect("/login?error=slack");
    }

    const claims = decodeIdToken(token.id_token);
    const slackUserId = claims["https://slack.com/user_id"] ?? claims.sub;

    // Fall back to the email so somebody added by email alone can still sign in
    // with Slack, and vice versa.
    const person = (await findPerson({ slackUserId }))
      ?? (claims.email ? await findPerson({ email: claims.email }) : null);

    if (!person?.can_admin || !person.is_active) {
      return res.redirect(`/login?error=not_allowed&slack_id=${encodeURIComponent(slackUserId)}`);
    }

    await query("update followup_operators set last_seen_at = now() where id = $1", [person.id]);

    const id = await createSession({
      userId: person.id,
      provider: "slack",
      displayName: person.display_name ?? claims.name ?? null,
      email: person.email ?? claims.email ?? null,
      slackUserId,
    });
    setCookie(res, COOKIE, id, SESSION_DAYS * 24 * 60 * 60);
    return res.redirect("/");
  } catch (error) {
    return next(error);
  }
});

/* ---------------------------------------------------------------- password */

authRouter.post("/password", express.json(), async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(400).json({ error: "Password sign-in is not enabled." });

  const provided = String(req.body?.password ?? "");
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "That password is not right." });
  }

  const id = await createSession({
    userId: null,
    provider: "password",
    displayName: "Administrator",
    email: null,
    slackUserId: null,
  });
  setCookie(res, COOKIE, id, SESSION_DAYS * 24 * 60 * 60);
  return res.json({ ok: true });
});

authRouter.post("/logout", async (req, res) => {
  const id = req.cookies?.[COOKIE];
  if (id) await query("delete from app_sessions where id = $1", [id]);
  clearCookie(res, COOKIE);
  res.json({ ok: true });
});

// Solves the chicken and egg: the access list decides who can sign in, but
// somebody has to sign in to edit the access list. Naming an email here grants
// it dashboard access at boot, so the first administrator can come straight in
// with Google rather than through the password.
//
// It only ever grants. Removing an address here does not revoke anything —
// that is done in the app, deliberately, so access changes are visible.
export async function ensureBootstrapAdmins() {
  const raw = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!raw) return [];

  const granted = [];
  for (const entry of raw.split(",")) {
    const email = entry.trim().toLowerCase();
    if (!email) continue;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      console.warn(`  BOOTSTRAP_ADMIN_EMAIL: "${email}" is not an email address, skipping.`);
      continue;
    }

    // The unique index on email is partial, so an ON CONFLICT would have to
    // restate its predicate. Reading first is clearer and just as correct.
    const existing = await one("select id, can_admin, is_active from followup_operators where email = $1", [email]);
    if (existing) {
      if (!existing.can_admin || !existing.is_active) {
        await query("update followup_operators set can_admin = true, is_active = true where id = $1", [existing.id]);
        granted.push(`${email} (access restored)`);
      }
    } else {
      await query(
        `insert into followup_operators (email, display_name, can_admin, is_active)
         values ($1, $2, true, true)`,
        [email, email.split("@")[0]],
      );
      granted.push(`${email} (added)`);
    }
  }
  return granted;
}

export async function purgeExpiredSessions() {
  const result = await query("delete from app_sessions where expires_at < now()");
  return result.rowCount;
}
