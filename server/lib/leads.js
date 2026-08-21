import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { flattenSlackMessage, readLead } from "../../shared/leads.js";
import { rows } from "../db.js";

export { flattenSlackMessage, readLead };

// Reading a lead out of a Slack post happens in two halves, and the split is
// deliberate.
//
// The phone number is extracted here, in code, by the same parser the Slack
// shorthand uses. It is the one field where being wrong means texting a
// stranger, so it is never left to a model.
//
// Which track the lead belongs on is a judgement about prose — "was hit by a
// truck" against "Resbalón y Caída" against a referral — and that is what the
// model is for. Being wrong there is visible in Slack and fixable before the
// second text goes out.

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
      description: "True only if this is a new prospective client's contact details. "
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
      description: "A few words for the record, e.g. 'rear-ended by a truck', 'slip and fall'.",
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
    "case_type", "lead_source", "confidence", "reasoning"],
  additionalProperties: false,
};

const SYSTEM = `You route inbound leads for a Texas personal injury law firm.

A Slack channel receives new leads from several places — the firm's website form,
a website chatbot, Facebook and TikTok lead forms, and a Meta form. Each posts a
differently shaped message. Your job is to read one of those posts and decide
which follow-up text sequence the person should go into.

Rules:

- Choose sequence_slug from the list of sequences you are given, and nothing
  else. Never invent a slug. If none is a good fit, return null and the firm
  will use its default.
- Judge the case type from what the person actually wrote about their situation,
  not from the ad or campaign name. A campaign called "Slip ES" that produced a
  lead describing a car crash is a car crash.
- language is the language to TEXT THEM IN. Spanish if the form says Spanish, if
  they wrote in Spanish, or if the source is a Spanish campaign. Otherwise
  English. When genuinely unsure, English.
- first_name is a first name only — "Amber", not "Amber Hill". Leave it null
  rather than guessing at an unclear one, because it goes into the text they
  receive.
- Someone asking to refer a case, or who says they are another attorney or a
  firm, belongs on a referral track rather than a client one.
- is_lead is false for anything that is not a new prospective client: test posts,
  status updates, staff conversation, an existing client's message.
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
  const menu = sequences
    .map((s) => `- ${s.slug}: ${s.name}${s.description ? ` — ${s.description}` : ""}`)
    .join("\n");
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

// The sequences the classifier is allowed to choose from are simply the active
// ones. Adding a track in the dashboard therefore extends the router with no
// code change here — the name and description a person wrote for their own
// benefit are also what the model reads.
export async function routableSequences() {
  return rows(
    `select slug, name, coalesce(description, '') as description
     from followup_sequences q
     where q.is_active and q.auto_routable
       and exists (select 1 from followup_steps s where s.sequence_id = q.id and s.is_active)
     order by q.name`,
  );
}

export async function classifyLead(text) {
  const sequences = await routableSequences();
  if (!sequences.length) return { ok: false, reason: "no_active_sequences" };

  const provider = llmProvider();
  if (!provider || !llmConfigured()) return { ok: false, reason: "llm_not_configured" };

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

// Read a Slack post and say what should happen. Returns a decision rather than
// acting on one, so the caller can honour the auto-start setting and so this is
// testable without a Slack workspace.
export async function assessLeadPost(event) {
  const text = flattenSlackMessage(event);
  if (!text) return { act: false, reason: "empty_message" };

  const read = readLead(text);
  if (!read.phone) return { act: false, reason: "no_phone", text };

  const classified = await classifyLead(text);
  if (!classified.ok) {
    // The number is good even when the model is not, so this still becomes a
    // lead — on the default sequence, which is what a human would reach for.
    return {
      act: true,
      phone: read.phone,
      email: read.email,
      sequenceSlug: null,
      language: null,
      firstName: null,
      confidence: "low",
      reasoning: `Routed to the default sequence: ${classified.reason}.`,
      classifierFailed: classified.reason,
      text,
    };
  }

  if (!classified.is_lead) return { act: false, reason: "not_a_lead", text };

  return {
    act: true,
    phone: read.phone,
    email: read.email,
    sequenceSlug: classified.sequence_slug,
    language: classified.language,
    firstName: classified.first_name,
    lastName: classified.last_name,
    caseType: classified.case_type,
    leadSource: classified.lead_source,
    confidence: classified.confidence,
    reasoning: classified.reasoning,
    text,
  };
}
