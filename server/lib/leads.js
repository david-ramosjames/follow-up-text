import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { flattenSlackMessage, isOutboundReferral, kindSlug, normalizeCaseType, pickTrackSlug, readLead } from "../../shared/leads.js";
import { missingMergeTokens } from "../../shared/messaging.js";
import { rows } from "../db.js";
import { currentFirm } from "./firms.js";

export { flattenSlackMessage, readLead, isOutboundReferral, kindSlug, pickTrackSlug, normalizeCaseType };

// Reading a lead out of a Slack post happens in two halves, and the split is
// deliberate.
//
// The phone number is extracted here, in code, by the same parser the Slack
// shorthand uses. It is the one field where being wrong means texting a
// stranger, so it is never left to a model.
//
// Which track the lead belongs on is a judgement about prose — "was hit by a
// truck" against "Resbalón y Caída" — and that is what the model is for.
// Forms marked Referral are parsed in code: this firm will send them out.

// Either provider can do the routing. Which one is chosen by LEAD_LLM_PROVIDER
// if it is set, otherwise by which key is present — so dropping an
// OPENAI_API_KEY into the environment is enough to switch, with nothing else to
// change. Both keys live in the environment, never in the database, because
// they are secrets.
export function llmProvider() {
  const explicit = String(process.env.LEAD_LLM_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "openai" || explicit === "anthropic") return explicit;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return null;
}

export function llmConfigured() {
  const provider = llmProvider();
  if (provider === "openai") return Boolean(process.env.OPENAI_API_KEY);
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  return false;
}

// A one-line "who is doing the routing", shown on the Leads page so the answer
// to "how is this being classified?" includes which model made the call.
export function llmDescription() {
  const provider = llmProvider();
  if (!provider || !llmConfigured()) return null;
  const model = provider === "openai"
    ? (process.env.OPENAI_MODEL || "gpt-4o-mini")
    : (process.env.ANTHROPIC_MODEL || "claude-opus-5");
  return { provider, model };
}

/* --------------------------------------------------------- classification */

const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    is_lead: {
      type: "boolean",
      description: "True if this is a new prospective client's contact details, including "
        + "a form marked Referral (this firm will send them to another lawyer). "
        + "Status updates, internal chatter and bot noise are not leads.",
    },
    sequence_slug: {
      type: ["string", "null"],
      description: "The slug of the sequence that best fits, chosen from the list given. "
        + "Null if none fits well.",
    },
    first_name: { type: ["string", "null"], description: "The person's first name only." },
    last_name: { type: ["string", "null"] },
    language: { type: "string", enum: ["en", "es"], description: "The language to text them in." },
    case_type: {
      type: ["string", "null"],
      description: "A short noun phrase that reads naturally after 'your' in a text, "
        + "e.g. 'car accident', 'slip and fall', 'sexual assault involving an Uber driver'. "
        + "Same language as `language`. Not a comma list or a file label. Null if unknown.",
    },
    case_detail: {
      type: ["string", "null"],
      description: "The more exact situation for staff, e.g. 'sexual assault, Uber driver, MDL'. "
        + "Never sent in a text. Null if nothing extra to log.",
    },
    lead_source: {
      type: ["string", "null"],
      description: "Which system posted this, e.g. website, chatbot, facebook, tiktok, leadform.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "How sure you are about sequence_slug specifically.",
    },
    reasoning: { type: "string", description: "One sentence. Shown to staff in Slack." },
  },
  required: ["is_lead", "sequence_slug", "first_name", "last_name", "language",
    "case_type", "case_detail", "lead_source", "confidence", "reasoning"],
  additionalProperties: false,
};

const SYSTEM = `You route inbound leads for a Texas personal injury law firm.

A Slack channel receives new leads from several places — the firm's website form,
a website chatbot, Facebook and TikTok lead forms, and a Meta form. Each posts a
differently shaped message. Your job is to read one of those posts and decide
which follow-up text sequence the person should go into.

Rules:

- Choose sequence_slug from the list of sequences you are given, and nothing
  else. Never invent a slug.
- An injured person this firm may represent is the qualified-lead track. A form
  marked Referral or Referal is the referral track.
- If none is a good fit, return null. Do not pick a sequence that is not on the
  list.
- Judge what happened from what the person actually wrote, not from the ad or
  campaign name. A campaign called "Slip ES" that produced a lead describing a
  car crash is a car crash.
- case_type is pasted into texts after the word "your" (or "su" in Spanish). It
  has to sound like something a person would say, not a form label. "car accident"
  and "sexual assault involving an Uber driver" work. "sexual assault, Uber
  driver" does not — that reads as "about your sexual assault, Uber driver".
  Write it in the same language as the language field. Keep it short. Do not start it
  with "your" or "su". Do not use a comma list. If writing Spanish, avoid á, í,
  ó, ú so the text stays one SMS segment.
- case_detail is the exact situation for the file — parties, vehicle type, MDL,
  whatever is useful internally. It is never texted. A comma list is fine there.
- language is the language to TEXT THEM IN. Spanish if the form says Spanish, if
  they wrote in Spanish, or if the source is a Spanish campaign. Otherwise
  English. When genuinely unsure, English.
- first_name is a first name only — "Amber", not "Amber Hill". Leave it null
  rather than guessing at an unclear one, because it goes into the text they
  receive.
- If the post is marked Referral or Referal, this firm will send the person to
  another lawyer. That is the referral track. It is not another attorney sending
  us a case, and it is not a qualified lead we will represent ourselves.
- is_lead is false for anything that is not a new prospective client: test posts,
  status updates, staff conversation, an existing client's message. A form marked
  Referral is still a lead.
- confidence describes sequence_slug only. Use "low" when the post says nothing
  about what happened to them.`;

let anthropicClient = null;
function anthropic() {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

let openaiClient = null;
function openai() {
  if (!openaiClient) openaiClient = new OpenAI();
  return openaiClient;
}

// The one prompt both providers share. Kept identical so switching provider
// changes only the model, not what it is asked to do.
function buildPrompt(sequences, text) {
  const menu = sequences.length
    ? sequences.map((s) => `- ${s.slug}: ${s.name}${s.description ? ` — ${s.description}` : ""}`).join("\n")
    : "(none are set up yet — return sequence_slug: null, but still fill in everything else)";
  return `Sequences you may choose from:\n${menu}\n\nThe Slack post:\n"""\n${text}\n"""`;
}

async function classifyWithAnthropic(sequences, text) {
  const response = await anthropic().messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
    max_tokens: 2048,
    system: SYSTEM,
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: CLASSIFICATION_SCHEMA },
    },
    messages: [{ role: "user", content: buildPrompt(sequences, text) }],
  });

  if (response.stop_reason === "refusal") {
    return { ok: false, reason: "refused", detail: response.stop_details?.category ?? null };
  }
  const block = response.content.find((item) => item.type === "text");
  if (!block) return { ok: false, reason: "no_content" };
  return { ok: true, parsed: JSON.parse(block.text) };
}

async function classifyWithOpenAI(sequences, text) {
  const response = await openai().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: buildPrompt(sequences, text) },
    ],
    // Structured outputs: the model is constrained to the same schema, so both
    // providers return the identical shape.
    response_format: {
      type: "json_schema",
      json_schema: { name: "lead_routing", strict: true, schema: CLASSIFICATION_SCHEMA },
    },
  });

  const choice = response.choices?.[0];
  if (choice?.finish_reason === "content_filter") {
    return { ok: false, reason: "refused", detail: "content_filter" };
  }
  const content = choice?.message?.content;
  if (!content) return { ok: false, reason: "no_content" };
  return { ok: true, parsed: JSON.parse(content) };
}

// Tracks the classifier may assign. Sequence is on (is_active) is whether texts
// actually go out — not whether a form can be assigned here. Switching Qualified
// lead off used to hide it from this list, so injury posts fell through.
export async function routableSequences() {
  const id = currentFirm()?.id;
  return rows(
    `select slug, name, coalesce(description, '') as description, is_active
     from followup_sequences q
     where q.auto_routable
       and ($1::uuid is null or q.firm_id = $1)
       and exists (select 1 from followup_steps s where s.sequence_id = q.id and s.is_active)
     order by q.name`,
    [id ?? null],
  );
}

export async function classifyLead(text) {
  const sequences = await routableSequences();

  const provider = llmProvider();
  if (!provider || !llmConfigured()) return { ok: false, reason: "llm_not_configured" };

  // No sequences yet is not a reason to skip the model. Watch-and-record exists
  // precisely so somebody can see how leads are read *before* building any
  // sequence, so the model still runs and still extracts the name, case type,
  // language and whether it is a lead — it just has nothing to route to, so
  // sequence_slug comes back null. This is the chicken-and-egg the preview mode
  // is meant to break.

  try {
    const result = provider === "openai"
      ? await classifyWithOpenAI(sequences, text)
      : await classifyWithAnthropic(sequences, text);
    if (!result.ok) return { ...result, provider };

    const parsed = result.parsed;
    const allowed = new Set(sequences.map((s) => s.slug));

    // A slug outside the menu is treated as no choice at all rather than
    // passed through to fail an enrollment later.
    if (parsed.sequence_slug && !allowed.has(parsed.sequence_slug)) {
      parsed.invalid_slug = parsed.sequence_slug;
      parsed.sequence_slug = null;
      parsed.confidence = "low";
    }

    return { ok: true, provider, ...parsed };
  } catch (error) {
    console.error(`lead classification failed (${provider})`, error);
    // Both SDKs expose the same typed-error names, so one set of checks covers
    // whichever provider is in use.
    const name = error?.constructor?.name ?? "";
    if (error?.status === 429 || name === "RateLimitError") return { ok: false, reason: "rate_limited", provider };
    if (error?.status === 401 || name === "AuthenticationError") return { ok: false, reason: "bad_api_key", provider };
    return { ok: false, reason: "error", detail: error.message, provider };
  }
}

/* ------------------------------------------------------------ the whole job */

function caseFields(classified) {
  const caseType = normalizeCaseType(classified?.case_type);
  const caseDetail = String(classified?.case_detail ?? "").replace(/\s+/g, " ").trim() || null;
  return {
    caseType,
    caseDetail: caseDetail && caseDetail !== caseType ? caseDetail : null,
  };
}

// Read a Slack post and say what should happen. Returns a decision rather than
// acting on one, so the caller can honour the auto-start setting and so this is
// testable without a Slack workspace.
export async function assessLeadPost(event) {
  const text = flattenSlackMessage(event);
  if (!text) return { act: false, reason: "empty_message" };

  const read = readLead(text);
  if (!read.phone) return { act: false, reason: "no_phone", text };

  const classified = await classifyLead(text);
  const referral = isOutboundReferral(text);
  const tracks = await routableSequences();
  let sequenceSlug = pickTrackSlug({
    preferred: classified.ok ? classified.sequence_slug : null,
    referral,
    tracks,
  });
  let reasoning = classified.ok
    ? classified.reasoning
    : `Routed to ${sequenceSlug ?? "the default sequence"}: ${classified.reason}.`;

  // The form itself says Referral. Honour that even when the model missed it
  // or the classifier is down, so those posts cannot land on the qualified track.
  if (referral && tracks.some((track) => track.slug === "referral")) {
    sequenceSlug = "referral";
    reasoning = classified.ok
      ? `The form is marked referral, so it was parsed onto that track. ${classified.reasoning ?? ""}`.trim()
      : "The form is marked referral.";
  }

  if (!classified.ok) {
    return {
      act: true,
      phone: read.phone,
      email: read.email,
      sequenceSlug,
      classifierSlug: referral ? "referral" : null,
      language: null,
      firstName: null,
      confidence: "low",
      reasoning,
      classifierFailed: classified.reason,
      text,
    };
  }

  if (!classified.is_lead && !referral) {
    return {
      act: false,
      reason: "not_a_lead",
      text,
      phone: read.phone,
      email: read.email,
      firstName: classified.first_name,
      lastName: classified.last_name,
      language: classified.language,
      ...caseFields(classified),
      leadSource: classified.lead_source,
      sequenceSlug: classified.sequence_slug,
      classifierSlug: kindSlug({ preferred: classified.sequence_slug, referral }),
      confidence: classified.confidence,
      reasoning: classified.reasoning,
    };
  }

  return {
    act: true,
    phone: read.phone,
    email: read.email,
    sequenceSlug,
    classifierSlug: kindSlug({ preferred: classified.sequence_slug, referral }),
    language: classified.language,
    firstName: classified.first_name,
    lastName: classified.last_name,
    ...caseFields(classified),
    leadSource: classified.lead_source,
    confidence: classified.confidence,
    reasoning,
    text,
  };
}

/* -------------------------------------------------------------- translation */

const TRANSLATE_SYSTEM = `You translate SMS copy for a Texas personal injury law firm from English into Spanish.

Reply with the Spanish text only — no quotes, no preamble, no explanation.

Keep every {{merge_field}} token exactly as written, including the braces and the English name inside. Do not translate first_name, firm_name, case_type, assigned_user, or any other token name.

Do not add a greeting, opt-out line, or signature the English did not have.

Prefer GSM-7 SMS characters so the text stays one segment: é and ñ are fine; do not use á, í, ó, or ú. Write "esta" not "está", "si" not "sí", "aqui" not "aquí", "numero" not "número". Do not use inverted ¿ or ¡. This is a text message — keep a similar length.`;

function cleanTranslation(text) {
  return String(text ?? "")
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

async function translateWithAnthropic(text) {
  const response = await anthropic().messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
    max_tokens: 1024,
    system: TRANSLATE_SYSTEM,
    messages: [{ role: "user", content: text }],
  });
  if (response.stop_reason === "refusal") {
    return { ok: false, reason: "refused", detail: response.stop_details?.category ?? null };
  }
  const block = response.content.find((item) => item.type === "text");
  if (!block?.text) return { ok: false, reason: "no_content" };
  return { ok: true, spanish: cleanTranslation(block.text) };
}

async function translateWithOpenAI(text) {
  const response = await openai().chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [
      { role: "system", content: TRANSLATE_SYSTEM },
      { role: "user", content: text },
    ],
  });
  const choice = response.choices?.[0];
  if (choice?.finish_reason === "content_filter") {
    return { ok: false, reason: "refused", detail: "content_filter" };
  }
  const content = choice?.message?.content;
  if (!content) return { ok: false, reason: "no_content" };
  return { ok: true, spanish: cleanTranslation(content) };
}

// English to Spanish for a single SMS body. Merge tokens are checked in code
// because a dropped {{first_name}} would go out as the literal braces.
export async function translateToSpanish(text) {
  const english = String(text ?? "").trim();
  if (!english) return { ok: false, reason: "empty" };

  const provider = llmProvider();
  if (!provider || !llmConfigured()) return { ok: false, reason: "llm_not_configured" };

  try {
    const result = provider === "openai"
      ? await translateWithOpenAI(english)
      : await translateWithAnthropic(english);
    if (!result.ok) return { ...result, provider };

    const missing = missingMergeTokens(english, result.spanish);
    if (missing.length) {
      return { ok: false, reason: "lost_merge_fields", missing, provider, spanish: result.spanish };
    }
    return { ok: true, provider, spanish: result.spanish };
  } catch (error) {
    console.error(`translation failed (${provider})`, error);
    const name = error?.constructor?.name ?? "";
    if (error?.status === 429 || name === "RateLimitError") return { ok: false, reason: "rate_limited", provider };
    if (error?.status === 401 || name === "AuthenticationError") return { ok: false, reason: "bad_api_key", provider };
    return { ok: false, reason: "error", detail: error.message, provider };
  }
}
