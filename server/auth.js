import crypto from "node:crypto";
import express from "express";
import { one, query, rows } from "./db.js";

// Slack is the system of record for who works here, so the dashboard signs in
// with Slack and the operator list doubles as the access list. No second set of
// accounts to keep in step.
//
// ADMIN_PASSWORD is a deliberate escape hatch: somebody has to be able to get in
// and add the first operator before anybody is on the list, and to get back in if
// the Slack app is broken.

const COOKIE = "followup_session";
const SESSION_DAYS = 14;

export function authConfigured() {
  return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

function publicUrl(req) {
  const configured = process.env.PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return configured;
  // Railway terminates TLS in front of the app, so trust the forwarded proto.
  const proto = req.get("x-forwarded-proto") ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
  };
}

async function createSession(profile) {
  const id = crypto.randomBytes(32).toString("base64url");
  await query(
    `insert into app_sessions (id, slack_user_id, display_name, email, is_supervisor, expires_at)
     values ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)`,
    [id, profile.slackUserId, profile.displayName, profile.email, profile.isSupervisor, String(SESSION_DAYS)],
  );
  return id;
}

export async function readSession(req) {
  const id = req.cookies?.[COOKIE];
  if (!id) return null;
  const session = await one(
    `select id, slack_user_id, display_name, email, is_supervisor
     from app_sessions where id = $1 and expires_at > now()`,
    [id],
  );
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

// Minimal signed-cookie parsing so the app carries no extra dependency for it.
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

export const authRouter = express.Router();

authRouter.get("/me", async (req, res) => {
  const session = await readSession(req);
  const operatorCount = await one("select count(*)::int as count from followup_operators where can_admin and is_active");
  res.json({
    signedIn: Boolean(session),
    user: session
      ? {
        slackUserId: session.slack_user_id,
        displayName: session.display_name,
        email: session.email,
        isSupervisor: session.is_supervisor,
      }
      : null,
    slackSignInAvailable: authConfigured(),
    passwordSignInAvailable: Boolean(process.env.ADMIN_PASSWORD),
    // Surfaced so the sign-in page can explain the first-run state instead of
    // just refusing everybody.
    hasAdmins: (operatorCount?.count ?? 0) > 0,
  });
});

authRouter.get("/slack/start", (req, res) => {
  if (!authConfigured()) return res.status(400).send("Sign in with Slack is not configured.");
  const state = crypto.randomBytes(16).toString("base64url");
  res.setHeader("Set-Cookie", `followup_oauth_state=${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`
    + (process.env.NODE_ENV === "production" ? "; Secure" : ""));

  const url = new URL("https://slack.com/openid/connect/authorize");
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", `${publicUrl(req)}/auth/slack/callback`);
  url.searchParams.set("state", state);
  if (process.env.SLACK_TEAM_ID) url.searchParams.set("team", process.env.SLACK_TEAM_ID);
  res.redirect(url.toString());
});

authRouter.get("/slack/callback", async (req, res, next) => {
  try {
    if (!authConfigured()) return res.status(400).send("Sign in with Slack is not configured.");
    if (!req.query.code) return res.redirect("/login?error=cancelled");
    if (!req.query.state || req.query.state !== req.cookies?.followup_oauth_state) {
      return res.redirect("/login?error=state");
    }

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

    // The id_token is signed by Slack and arrived over TLS straight from Slack's
    // token endpoint, so the claims are read directly rather than re-verified.
    const claims = JSON.parse(Buffer.from(token.id_token.split(".")[1], "base64url").toString("utf8"));
    const slackUserId = claims["https://slack.com/user_id"] ?? claims.sub;

    const operator = await one(
      `select slack_user_id, display_name, is_supervisor, can_admin
       from followup_operators where slack_user_id = $1 and is_active`,
      [slackUserId],
    );

    if (!operator?.can_admin) {
      return res.redirect(`/login?error=not_allowed&slack_id=${encodeURIComponent(slackUserId)}`);
    }

    await query("update followup_operators set last_seen_at = now() where slack_user_id = $1", [slackUserId]);

    const id = await createSession({
      slackUserId,
      displayName: operator.display_name ?? claims.name ?? null,
      email: claims.email ?? null,
      isSupervisor: operator.is_supervisor,
    });

    const options = cookieOptions();
    res.setHeader("Set-Cookie", `${COOKIE}=${id}; HttpOnly; Path=/; Max-Age=${options.maxAge / 1000}; SameSite=Lax`
      + (options.secure ? "; Secure" : ""));
    return res.redirect("/");
  } catch (error) {
    return next(error);
  }
});

authRouter.post("/password", express.json(), async (req, res) => {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(400).json({ error: "Password sign-in is not enabled." });

  const provided = String(req.body?.password ?? "");
  const a = Buffer.from(provided.padEnd(64).slice(0, 64));
  const b = Buffer.from(expected.padEnd(64).slice(0, 64));
  if (!crypto.timingSafeEqual(a, b) || provided !== expected) {
    return res.status(401).json({ error: "That password is not right." });
  }

  const id = await createSession({
    slackUserId: null,
    displayName: "Administrator",
    email: null,
    isSupervisor: true,
  });
  const options = cookieOptions();
  res.setHeader("Set-Cookie", `${COOKIE}=${id}; HttpOnly; Path=/; Max-Age=${options.maxAge / 1000}; SameSite=Lax`
    + (options.secure ? "; Secure" : ""));
  return res.json({ ok: true });
});

authRouter.post("/logout", async (req, res) => {
  const id = req.cookies?.[COOKIE];
  if (id) await query("delete from app_sessions where id = $1", [id]);
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

export async function purgeExpiredSessions() {
  const result = await query("delete from app_sessions where expires_at < now()");
  return result.rowCount;
}

export async function countAdmins() {
  const found = await rows("select 1 from followup_operators where can_admin and is_active limit 1");
  return found.length;
}
