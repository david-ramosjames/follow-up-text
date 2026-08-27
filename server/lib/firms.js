import { AsyncLocalStorage } from "node:async_hooks";
import { one, query, rows } from "../db.js";

const storage = new AsyncLocalStorage();

export const CREDENTIAL_KEYS = [
  "slack_bot_token",
  "slack_signing_secret",
  "slack_app_id",
  "slack_team_id",
  "quo_api_key",
  "quo_webhook_secret",
];

export function runWithFirm(firm, fn) {
  return storage.run(firm, fn);
}

export function currentFirm() {
  return storage.getStore() ?? null;
}

export function firmId() {
  const id = currentFirm()?.id;
  if (!id) throw new Error("No firm is in context.");
  return id;
}

export function isDefaultFirm(firm) {
  return Boolean(firm?.is_default);
}

function slugify(name) {
  const slug = String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "firm";
}

export function publicFirm(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    isDefault: Boolean(row.is_default),
    credentials: {
      slackBotToken: Boolean(row.slack_bot_token) || (row.is_default && Boolean(process.env.SLACK_BOT_TOKEN)),
      slackSigningSecret: Boolean(row.slack_signing_secret) || (row.is_default && Boolean(process.env.SLACK_SIGNING_SECRET)),
      slackAppId: Boolean(row.slack_app_id) || (row.is_default && Boolean(process.env.SLACK_APP_ID)),
      slackTeamId: Boolean(row.slack_team_id) || (row.is_default && Boolean(process.env.SLACK_TEAM_ID)),
      quoApiKey: Boolean(row.quo_api_key) || (row.is_default && Boolean(process.env.QUO_API_KEY)),
      quoWebhookSecret: Boolean(row.quo_webhook_secret)
        || (row.is_default && Boolean(process.env.QUO_WEBHOOK_SECRET || process.env.QUO_WEBHOOK_TOKEN)),
    },
  };
}

function missingRelation(error) {
  return error?.code === "42P01";
}

export async function listFirms() {
  try {
    return await rows(`
      select id, slug, name, is_default, is_active, created_at,
             slack_bot_token, slack_signing_secret, slack_app_id, slack_team_id,
             quo_api_key, quo_webhook_secret
      from firms
      where is_active
      order by is_default desc, created_at, name
    `);
  } catch (error) {
    if (missingRelation(error)) return [];
    throw error;
  }
}

export async function loadFirm(id) {
  if (!id) return null;
  try {
    return await one("select * from firms where id = $1 and is_active", [id]);
  } catch (error) {
    if (missingRelation(error)) return null;
    throw error;
  }
}

export async function defaultFirm() {
  try {
    return await one("select * from firms where is_active order by is_default desc, created_at, name limit 1");
  } catch (error) {
    if (missingRelation(error)) return null;
    throw error;
  }
}

export async function resolveFirm(req) {
  const requested = req.get?.("x-firm-id") || req.query?.firmId || req.body?.firm_id;
  if (!requested) return defaultFirm();

  try {
    const found = await loadFirm(requested);
    if (found) return found;
  } catch (error) {
    if (error.code !== "22P02") throw error;
  }

  // A stale or unknown id must not silently fall back to Ramos James — that
  // is how the new firm's dashboard showed the default firm's numbers.
  const error = new Error("That firm is not available.");
  error.status = 404;
  throw error;
}

export async function uniqueSlug(name) {
  const base = slugify(name);
  const taken = new Set((await rows("select slug from firms")).map((row) => row.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`.slice(0, 60);
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function createFirm({ name, actor = null }) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("A firm name is required.");
  const slug = await uniqueSlug(trimmed);
  const firm = await one(
    `insert into firms (slug, name, is_default, is_active)
     values ($1, $2, false, true)
     returning *`,
    [slug, trimmed],
  );

  const { SETTING_DEFINITIONS } = await import("./settings.js");
  for (const definition of SETTING_DEFINITIONS) {
    const value = definition.key === "firm_name" ? trimmed : definition.default;
    await query(
      `insert into app_settings (firm_id, key, value, updated_by)
       values ($1, $2, $3::jsonb, $4)
       on conflict (firm_id, key) do nothing`,
      [firm.id, definition.key, JSON.stringify(value), actor],
    );
  }

  return firm;
}

export async function renameFirm(id, name) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) throw new Error("A firm name is required.");
  const firm = await one(
    "update firms set name = $2 where id = $1 and is_active returning *",
    [id, trimmed],
  );
  if (!firm) throw new Error("No such firm.");
  await query(
    `insert into app_settings (firm_id, key, value)
     values ($1, 'firm_name', $2::jsonb)
     on conflict (firm_id, key) do update set value = excluded.value, updated_at = now()`,
    [id, JSON.stringify(trimmed)],
  );
  return firm;
}

export async function saveFirmCredentials(id, credentials = {}) {
  const updates = [];
  const values = [id];
  for (const key of CREDENTIAL_KEYS) {
    if (!(key in credentials)) continue;
    const raw = credentials[key];
    // Blank means leave the stored secret alone, so saving Settings does not
    // wipe tokens. Null clears it so the default firm falls back to env.
    if (raw === "" || raw === undefined) continue;
    values.push(raw === null ? null : String(raw).trim() || null);
    updates.push(`${key} = $${values.length}`);
  }
  if (!updates.length) return loadFirm(id);
  return one(
    `update firms set ${updates.join(", ")} where id = $1 returning *`,
    values,
  );
}

export function slackBotToken(firm = currentFirm()) {
  return firm?.slack_bot_token || (firm?.is_default || !firm ? process.env.SLACK_BOT_TOKEN : null) || null;
}

export function slackSigningSecret(firm = currentFirm()) {
  return firm?.slack_signing_secret
    || (firm?.is_default || !firm ? process.env.SLACK_SIGNING_SECRET : null)
    || null;
}

export function slackAppId(firm = currentFirm()) {
  return firm?.slack_app_id || (firm?.is_default || !firm ? process.env.SLACK_APP_ID : null) || null;
}

export function quoApiKey(firm = currentFirm()) {
  return firm?.quo_api_key || (firm?.is_default || !firm ? process.env.QUO_API_KEY : null) || null;
}

export function quoWebhookSecret(firm = currentFirm()) {
  return firm?.quo_webhook_secret
    || (firm?.is_default || !firm ? process.env.QUO_WEBHOOK_SECRET : null)
    || null;
}

export async function firmForSlackTeam(teamId) {
  if (!teamId) return null;
  return one("select * from firms where is_active and slack_team_id = $1", [String(teamId)]);
}

export async function firmForQuoNumber({ quoNumberId, toNumber } = {}) {
  if (quoNumberId) {
    const byId = await one("select * from firms where id = (select firm_id from quo_numbers where id = $1 limit 1)", [quoNumberId]);
    if (byId) return byId;
  }
  if (toNumber) {
    const byPhone = await one(
      `select f.* from firms f
       join quo_numbers n on n.firm_id = f.id
       where n.is_active and n.phone_e164 = $1
       order by f.is_default desc limit 1`,
      [toNumber],
    );
    if (byPhone) return byPhone;
  }
  return defaultFirm();
}
