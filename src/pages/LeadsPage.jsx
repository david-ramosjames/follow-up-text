import { CircleAlert, Eye, Inbox, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AppNav from "../components/AppNav";
import { api, formatWhen } from "../lib/api";
import { formatPhone } from "../../shared/messaging";
import { describeTrackKind, isOutboundReferral } from "../../shared/leads";

const FILTERS = [
  { value: "actionable", label: "Would text" },
  { value: "all", label: "Everything read" },
  { value: "ignored_sender", label: "Skipped senders" },
  { value: "not_a_lead", label: "Not a lead" },
];

const MODES = {
  off: { label: "Off", note: "The lead channel is not being read at all." },
  preview: {
    label: "Watch and record",
    note: "Every post is read and its decision recorded here. Nothing is texted and nothing "
      + "is posted to Slack.",
  },
  live: { label: "Live", note: "Follow-ups start automatically from these posts." },
};

const OUTCOMES = {
  started: { label: "Started", tone: "on" },
  preview_only: { label: "Would have started", tone: "active" },
  ignored_sender: { label: "Skipped — not a lead app", tone: "off" },
  not_a_lead: { label: "Read, not a lead", tone: "off" },
  no_phone: { label: "No usable number", tone: "off" },
  enroll_failed: { label: "Could not start", tone: "stopped_manual" },
  no_owner: { label: "No owner set", tone: "stopped_manual" },
  classifier_failed: { label: "Routing failed", tone: "stopped_manual" },
};

function classifierKind(item) {
  if (isOutboundReferral(item.post_text)) return "Referral";
  const label = describeTrackKind(item.classifier_slug)
    || describeTrackKind(item.sequence_slug);
  if (label) return label;
  if (item.classifier_error) return "Could not decide";
  if (item.is_lead) return "Qualified lead";
  return null;
}

function Classification({ item, tracks, onTrackChange, saving }) {
  const language = item.language === "es" ? "Spanish" : item.language === "en" ? "English" : null;
  const currentSlug = item.sequence_slug
    || tracks.find((track) => track.name === item.sequence_name)?.slug
    || "";
  const assigned = tracks.find((track) => track.slug === currentSlug);
  const kind = classifierKind(item);
  const facts = [
    ["Read as", kind],
    ["Language", language],
    ["First name", item.first_name],
    ["Case type", item.case_type],
    ["Source", item.lead_source],
    ["Confidence", item.confidence],
  ].filter(([, value]) => value);

  if (!facts.length && !item.reasoning && !tracks.length) return null;

  return (
    <dl className="lead-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
      {tracks.length > 0 && (
        <div className="wide">
          <dt>Assigned track</dt>
          <dd>
            <select
              value={currentSlug}
              disabled={saving}
              onChange={(event) => onTrackChange(event.target.value)}
            >
              {!currentSlug && <option value="">Choose a track…</option>}
              {tracks.map((track) => (
                <option key={track.slug} value={track.slug}>
                  {track.name}
                  {track.auto_routable ? "" : " — manual"}
                  {track.is_active ? "" : " — not sending"}
                </option>
              ))}
            </select>
            <small className="field-note">
              The sequence that would actually run. Change it only to preview a
              different first text. Does not send anything.
            </small>
            {assigned && !assigned.is_active && (
              <small className="field-note">
                This track is switched off, so Live will not send. Assignment still
                happened. Turn Sequence is on in the sequence editor when you are ready.
              </small>
            )}
          </dd>
        </div>
      )}
      {item.reasoning && (
        <div className="wide">
          <dt>Why</dt>
          <dd>{item.reasoning}</dd>
        </div>
      )}
    </dl>
  );
}

function Observation({ item, tracks, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const outcome = OUTCOMES[item.outcome] ?? { label: item.outcome, tone: "off" };
  const acted = item.outcome === "started" || item.outcome === "preview_only";

  const changeTrack = async (slug) => {
    if (!slug) return;
    setSaving(true);
    setError("");
    try {
      onUpdate(await api.patch(`/leads/${item.id}`, { sequence_slug: slug }));
    } catch (changeError) {
      setError(changeError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className={acted ? "live" : ""}>
      <header>
        <div>
          <h2>
            {item.first_name || item.sender_name || "Unnamed"}{" "}
            {item.phone_e164 && <span className="phone">{formatPhone(item.phone_e164)}</span>}
          </h2>
          <p>
            {item.sender_name && <>via {item.sender_name} · </>}
            {formatWhen(item.created_at)}
            {item.case_type && <> · {item.case_type}</>}
          </p>
        </div>
        <div className="card-status">
          <span className={`status-dot ${outcome.tone}`}>{outcome.label}</span>
          {item.confidence && <small>{item.confidence} confidence</small>}
        </div>
      </header>

      <Classification item={item} tracks={tracks} onTrackChange={changeTrack} saving={saving} />
      {error && <p className="form-error">{error}</p>}

      {acted && item.sequence_name && (
        <div className="next-send">
          <Inbox size={15} />
          <div>
            <strong>
              {item.sequence_name}
              {item.language && <span className="next-step"> · {item.language === "es" ? "Spanish" : "English"}</span>}
            </strong>
            {item.preview_next_at && (
              <small>
                {item.preview_is_night
                  ? `Night first text. Next one waits for the sending window — ${formatWhen(item.preview_next_at)}. A 4-hour gap does not send overnight.`
                  : `Next text ${formatWhen(item.preview_next_at)}.`}
              </small>
            )}
          </div>
        </div>
      )}

      {/* The whole point of watch-and-record: not "which sequence" but the exact
          words this person would have received. */}
      {item.preview_body && (
        <div className="preview">
          <p className="preview-label">The first text they would get</p>
          <p className="preview-body">{item.preview_body}</p>
          <p className="preview-meta">
            {item.preview_segments} segment{item.preview_segments === 1 ? "" : "s"}
            {item.preview_is_night ? " · night wording" : ""}
            {item.first_name ? "" : " · no first name was found, so the greeting falls back"}
          </p>
        </div>
      )}

      {item.classifier_error && (
        <p className="form-error">
          Routing fell back to the default sequence: {item.classifier_error}.
        </p>
      )}
      {item.outcome_detail && !item.classifier_error && (
        <p className="inline-note">{item.outcome_detail}</p>
      )}

      <footer>
        <small>
          {item.email && <>{item.email} · </>}
          {item.lead_source && <>source {item.lead_source} · </>}
          mode {item.mode}
        </small>
        <div className="card-actions">
          <button type="button" onClick={() => setOpen(!open)}>
            <Eye size={14} /> {open ? "Hide the post" : "The post it read"}
          </button>
        </div>
      </footer>

      {open && <pre className="lead-post">{item.post_text}</pre>}
    </article>
  );
}

export default function LeadsPage() {
  const [filter, setFilter] = useState("actionable");
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const didReadChannel = useRef(false);

  const load = useCallback(async ({ next = filter, fromSlack = false } = {}) => {
    setStatus("loading");
    setError("");
    try {
      let catchUp = null;
      if (fromSlack) {
        // Read the Slack channel, not just the database. Events are supposed
        // to fill this page on their own, but when they do not, this is how
        // this morning's posts actually get looked at. A cycle is capped so
        // the request cannot hang; keep going until the channel is current.
        for (let i = 0; i < 8; i += 1) {
          catchUp = await api.post("/leads/catch-up");
          if (catchUp?.error || catchUp?.skipped || !catchUp?.remaining) break;
        }
      }
      const query = next === "actionable"
        ? "?actionable=true"
        : `?outcome=${encodeURIComponent(next)}`;
      const payload = await api.get(`/leads${query}`);
      setData({ ...payload, catchUp: payload.catchUp ?? catchUp });
      setStatus("ready");
    } catch (loadError) {
      setError(loadError.message);
      setStatus("error");
    }
  }, [filter]);

  useEffect(() => {
    const fromSlack = !didReadChannel.current;
    didReadChannel.current = true;
    load({ next: filter, fromSlack });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const mode = MODES[data?.mode ?? "off"] ?? MODES.off;
  const counts = data?.counts ?? {};
  const heldTracks = (data?.routable ?? []).filter((track) => !track.is_active);

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Leads</p>
            <h1>What the lead channel is being read as</h1>
            <p>
              Every post the router has looked at, what it concluded, and the exact text the
              person would receive — so this can be watched before it is trusted to text
              anybody.
            </p>
          </div>
          <div className="heading-actions">
            <button type="button" className="button ghost" onClick={() => load({ fromSlack: true })}>
              <RefreshCw size={15} className={status === "loading" ? "spin" : ""} /> Refresh
            </button>
          </div>
        </header>

        <div className={`warning-panel ${data?.mode === "live" ? "" : "quiet"}`}>
          <h2>
            {data?.mode === "live" ? <CircleAlert size={15} /> : <Eye size={15} />}
            {" "}Currently: {mode.label}
          </h2>
          <p>
            {mode.note}
            {data?.channel
              ? <> Reading <code>{data.channel}</code>.</>
              : <> No channel is set, so nothing is read at all.</>}
            {data?.llm
              ? <> Routing with <strong>{data.llm.provider === "openai" ? "OpenAI" : "Anthropic"}</strong> (<code>{data.llm.model}</code>).</>
              : <> No routing key is set, so leads fall back to the default sequence.</>}
            {" "}Change this under <Link to="/settings">Settings</Link>.
          </p>
          {data && !data.routable?.length && (
            <p>
              <strong>No sequence is offered to the router yet.</strong> Tick “Offer this
              sequence to the lead router” on Qualified lead and Referral. Sequence is on
              only controls whether texts go out — it does not make a track.
            </p>
          )}
          {data?.routable?.length > 0 && (
            <p>
              Each form is assigned to one track: Referral if the Slack post is marked
              Referral or Referal, otherwise Qualified lead. Tracks:{" "}
              {data.routable.map((item) => item.name).join(", ")}.
            </p>
          )}
          {heldTracks.length > 0 && (
            <p>
              <strong>
                {heldTracks.map((track) => track.name).join(" and ")}{" "}
                {heldTracks.length === 1 ? "is" : "are"} switched off.
              </strong>{" "}
              The router will still assign forms to {heldTracks.length === 1 ? "it" : "them"},
              but Live will not send until you switch Sequence is on in the editor.
            </p>
          )}
        </div>

        <div className="stat-grid">
          <div className="stat-tile"><p className="stat-label">Would text</p>
            <p className="stat-value">{Number(counts.started ?? 0) + Number(counts.would_start ?? 0)}</p>
            <p className="stat-detail">last 30 days</p></div>
          <div className="stat-tile"><p className="stat-label">Skipped, wrong sender</p>
            <p className="stat-value">{Number(counts.ignored_sender ?? 0)}</p>
            <p className="stat-detail">not one of your lead apps</p></div>
          <div className="stat-tile"><p className="stat-label">Read, not a lead</p>
            <p className="stat-value">{Number(counts.not_a_lead ?? 0) + Number(counts.no_phone ?? 0)}</p>
            <p className="stat-detail">no number, or not a new client</p></div>
          <div className={`stat-tile ${Number(counts.problems ?? 0) > 0 ? "tone-warn" : ""}`}>
            <p className="stat-label">Problems</p>
            <p className="stat-value">{Number(counts.problems ?? 0)}</p>
            <p className="stat-detail">worth looking at</p></div>
        </div>

        <div className="tabs">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={filter === item.value ? "active" : ""}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {error && <p className="form-error">{error}</p>}
        {data?.catchUp?.error && <p className="form-error">{data.catchUp.error}</p>}
        {status === "loading" && <div className="page-state">Reading the lead channel…</div>}

        {status === "ready" && !data?.observations?.length && (
          <div className="empty-state">
            <h2>Nothing read yet</h2>
            <p>
              Posts appear here once the mode is set to Watch and record or Live, the lead
              channel is set, and the bot has been invited to it. Refresh reads the channel
              from Slack — it does not wait for events that may never have arrived.
            </p>
            {data?.catchUp?.remaining > 0 && (
              <p>Still catching up — hit Refresh again for the rest of this morning.</p>
            )}
            {data?.catchUp?.ok && data.catchUp.posted === 0 && (
              <p>
                Slack returned no posts in <code>{data.channel}</code> for the last two days.
                Confirm the ID under Settings and that the bot is in that channel.
              </p>
            )}
          </div>
        )}

        <div className="card-list">
          {(data?.observations ?? []).map((item) => (
            <Observation
              key={item.id}
              item={item}
              tracks={data?.tracks ?? []}
              onUpdate={(updated) => {
                setData((current) => ({
                  ...current,
                  observations: current.observations.map((row) => (
                    row.id === updated.id ? updated : row
                  )),
                }));
              }}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
