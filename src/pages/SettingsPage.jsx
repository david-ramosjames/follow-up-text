import { CheckCircle2, RefreshCw, Save, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import AppNav from "../components/AppNav";
import { api, TIMEZONES } from "../lib/api";

export default function SettingsPage() {
  const [definitions, setDefinitions] = useState([]);
  const [values, setValues] = useState({});
  const [numbers, setNumbers] = useState([]);
  const [environment, setEnvironment] = useState({});
  const [status, setStatus] = useState("loading");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [firm, setFirm] = useState(null);
  const [secrets, setSecrets] = useState({});
  const [newFirmName, setNewFirmName] = useState("");
  const [addingFirm, setAddingFirm] = useState(false);

  const load = async () => {
    try {
      const data = await api.get("/settings");
      setDefinitions(data.definitions);
      setValues(data.values);
      setNumbers(data.numbers);
      setEnvironment(data.environment);
      setFirm(data.firm ?? null);
      setStatus("ready");
    } catch (loadError) {
      setError(loadError.message);
      setStatus("error");
    }
  };

  useEffect(() => { load(); }, []);

  const set = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setSaved("");
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved("");
    try {
      const payload = { ...values };
      const filled = Object.fromEntries(Object.entries(secrets).filter(([, value]) => String(value ?? "").trim()));
      if (Object.keys(filled).length) payload.credentials = filled;
      await api.put("/settings", payload);
      setSecrets({});
      await load();
      setDirty(false);
      setSaved("Saved. The dispatcher picks these up within one cycle — no redeploy needed.");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  const sync = async () => {
    setSyncing(true);
    setError("");
    try {
      setNumbers(await api.post("/quo-numbers/sync"));
      setSaved("Numbers refreshed from Quo.");
    } catch (syncError) {
      setError(syncError.message);
    } finally {
      setSyncing(false);
    }
  };

  if (status === "loading") return <main className="page-state">Loading…</main>;

  const field = (definition) => {
    const value = values[definition.key];
    switch (definition.type) {
      case "boolean":
        return (
          <label className="checkbox wide" key={definition.key}>
            <input type="checkbox" checked={Boolean(value)} onChange={(event) => set(definition.key, event.target.checked)} />
            <span>
              <strong>{definition.label}</strong>
              {definition.help && <small>{definition.help}</small>}
            </span>
          </label>
        );
      case "number":
        return (
          <label key={definition.key}>
            <span>{definition.label}</span>
            <input
              type="number"
              min={definition.min}
              max={definition.max}
              value={value ?? ""}
              onChange={(event) => set(definition.key, Number(event.target.value))}
            />
            {definition.help && <small className="field-note">{definition.help}</small>}
          </label>
        );
      case "select":
        return (
          <label key={definition.key} className="wide">
            <span>{definition.label}</span>
            <select value={value ?? ""} onChange={(event) => set(definition.key, event.target.value)}>
              {(definition.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            {definition.help && <small className="field-note">{definition.help}</small>}
          </label>
        );
      case "timezone":
        return (
          <label key={definition.key}>
            <span>{definition.label}</span>
            <select value={value ?? ""} onChange={(event) => set(definition.key, event.target.value)}>
              {TIMEZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
            {definition.help && <small className="field-note">{definition.help}</small>}
          </label>
        );
      case "quo_number":
        return (
          <label key={definition.key} className="wide">
            <span>{definition.label}</span>
            <select value={value ?? ""} onChange={(event) => set(definition.key, event.target.value || null)}>
              <option value="">{definition.emptyLabel || "No default — every sequence must pick its own"}</option>
              {numbers.map((number) => (
                <option key={number.id} value={number.id} disabled={!number.is_active}>
                  {number.label ? `${number.label} — ${number.phone_e164}` : number.phone_e164}
                  {number.is_active ? "" : " (no longer in Quo)"}
                </option>
              ))}
            </select>
            {definition.help && <small className="field-note">{definition.help}</small>}
          </label>
        );
      default:
        return (
          <label key={definition.key} className="wide">
            <span>{definition.label}</span>
            <input value={value ?? ""} onChange={(event) => set(definition.key, event.target.value)} />
            {definition.help && <small className="field-note">{definition.help}</small>}
          </label>
        );
    }
  };

  const group = (keys) => definitions.filter((definition) => keys.includes(definition.key)).map(field);

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <div className="editor-bar">
          <span />
          <div>
            {dirty && <span className="unsaved">Unsaved changes</span>}
            <button type="button" className="button primary" onClick={save} disabled={saving || !dirty}>
              <Save size={15} /> {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        <header className="page-heading">
          <div>
            <p className="eyebrow">Configuration</p>
            <h1>Settings</h1>
            <p>
              Everything here is stored in the database and takes effect without a redeploy.
              Ramos James can keep using Railway env vars. Additional firms paste their Slack
              and Quo keys on this page — see <Link to="/help">Help</Link>.
            </p>
          </div>
        </header>

        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-ok">{saved}</p>}

        <section className="editor-section">
          <div>
            <h2>This firm</h2>
            <p>
              The switcher in the top bar picks which practice you are looking at. Each firm
              has its own sequences, leads, numbers, Slack workspace and sending keys. A new
              firm starts empty, with automatic sending off — import sequences from another
              firm on the Sequences page if you want the same copy.
            </p>
          </div>
          <div className="editor-fields">
            {group(["firm_name", "default_timezone"])}
            <label className="wide">
              <span>Add another firm</span>
              <div className="heading-actions">
                <input
                  value={newFirmName}
                  onChange={(event) => setNewFirmName(event.target.value)}
                  placeholder="e.g. Sister firm PLLC"
                />
                <button
                  type="button"
                  className="button ghost"
                  disabled={addingFirm || !newFirmName.trim()}
                  onClick={async () => {
                    setAddingFirm(true);
                    setError("");
                    try {
                      const created = await api.post("/firms", { name: newFirmName.trim() });
                      localStorage.setItem("followup_firm_id", created.id);
                      window.location.reload();
                    } catch (addError) {
                      setError(addError.message);
                      setAddingFirm(false);
                    }
                  }}
                >
                  {addingFirm ? "Adding…" : "Add firm"}
                </button>
              </div>
              <small className="field-note">
                Then switch to it, paste its Slack and Quo keys, refresh numbers, and import
                sequences from another firm on the Sequences page — or write new ones.
                Sending stays off until you turn a sequence on.
              </small>
            </label>
          </div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Keys for this firm</h2>
            <p>
              {firm?.isDefault
                ? "The default firm can keep using Railway env vars. Fill these in only if this practice should use different Slack or Quo credentials."
                : "This firm does not use the Railway env vars. Paste its Slack bot token, signing secret, and Quo API key here."}
            </p>
          </div>
          <div className="editor-fields">
            {[
              ["slack_bot_token", "Slack bot token", "xoxb-…", firm?.credentials?.slackBotToken],
              ["slack_signing_secret", "Slack signing secret", "From Basic Information", firm?.credentials?.slackSigningSecret],
              ["slack_app_id", "Slack app ID", "A0…", firm?.credentials?.slackAppId],
              ["slack_team_id", "Slack workspace ID", "T0… — needed if two firms share a signing secret", firm?.credentials?.slackTeamId],
              ["quo_api_key", "Quo API key", "From Quo workspace settings", firm?.credentials?.quoApiKey],
              ["quo_webhook_secret", "Quo webhook secret", "From the webhook in Quo", firm?.credentials?.quoWebhookSecret],
            ].map(([key, label, placeholder, isSet]) => (
              <label key={key} className="wide">
                <span>{label}{isSet ? " — set" : ""}</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={secrets[key] ?? ""}
                  placeholder={isSet ? "Leave blank to keep the current value" : placeholder}
                  onChange={(event) => {
                    setSecrets((current) => ({ ...current, [key]: event.target.value }));
                    setDirty(true);
                    setSaved("");
                  }}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Quo numbers</h2>
            <p>
              Pulled from your Quo workspace. Default is the fallback for sequences that have
              not picked their own. Secondary is the other line you sometimes start from by
              hand. When tagging the bot, type that line’s name as it appears in Quo —
              <code>from Intake</code>, not a nickname.
            </p>
          </div>
          <div className="editor-fields">
            <div className="wide">
              <button type="button" className="button ghost" onClick={sync} disabled={syncing || !environment.quoConfigured}>
                {syncing ? <RefreshCw size={14} className="spin" /> : <RefreshCw size={14} />}
                {syncing ? "Refreshing…" : "Refresh numbers from Quo"}
              </button>
              {!environment.quoConfigured && (
                <p className="field-note">Set <code>QUO_API_KEY</code> first.</p>
              )}
            </div>

            {numbers.length > 0 ? (
              <div className="wide table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th>Label</th><th>Number</th><th>ID</th><th>Status</th></tr>
                  </thead>
                  <tbody>
                    {numbers.map((number) => (
                      <tr key={number.id}>
                        <td><strong>{number.label || "—"}</strong></td>
                        <td>{number.phone_e164}</td>
                        <td><code>{number.id}</code></td>
                        <td>
                          <span className={`status-dot ${number.is_active ? "on" : "off"}`}>
                            {number.is_active ? "In Quo" : "Removed from Quo"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="field-note wide">No numbers yet. Refresh once your Quo key is set.</p>
            )}

            {group(["default_quo_number_id", "secondary_quo_number_id"])}
          </div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Slack</h2>
            <p>Where notifications go when a series has no thread of its own.</p>
          </div>
          <div className="editor-fields">{group(["slack_alert_channel", "show_full_phone_in_slack"])}</div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Lead intake</h2>
            <p>
              Reading a Slack channel of form fills and starting the matching series.
              Start on <em>Watch and record</em> and review the <Link to="/leads">Leads</Link>{" "}
              page before going Live. The routing key itself is an environment secret — see
              the panel below.
            </p>
          </div>
          <div className="editor-fields">
            {group([
              "lead_mode", "lead_channel_id", "lead_senders", "lead_default_owner_slack_id",
            ])}
          </div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Default night hours</h2>
            <p>
              Copied onto a sequence when you create it. After that, the split between usual
              copy and night copy is edited on the sequence itself — that is what the first
              text uses. Earliest/Latest on a sequence are still the sending window for later
              texts, not this wording switch.
            </p>
          </div>
          <div className="editor-fields">{group(["night_starts_hour", "night_ends_hour"])}</div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Sending</h2>
            <p>How often texts go out and how hard the system tries.</p>
          </div>
          <div className="editor-fields">
            {group([
              "send_stop_confirmation", "dispatch_interval_seconds", "dispatch_batch_size",
              "max_send_attempts", "retry_delay_minutes", "min_gap_minutes",
            ])}
          </div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Environment</h2>
            <p>Secrets, which can only be changed in Railway. This is read-only.</p>
          </div>
          <div className="editor-fields">
            <ul className="health-list wide">
              {[
                ["Quo API key", environment.quoConfigured, "QUO_API_KEY"],
                ["Quo webhook verification", environment.quoWebhookConfigured, "QUO_WEBHOOK_SECRET"],
                ["Slack signing secret", environment.slackSigningConfigured, "SLACK_SIGNING_SECRET"],
                ["Slack bot token", environment.slackBotConfigured, "SLACK_BOT_TOKEN"],
                ["Sign in with Google", environment.googleSignInConfigured, "GOOGLE_CLIENT_ID / SECRET"],
                ["Sign in with Slack", environment.slackSignInConfigured, "SLACK_CLIENT_ID / SECRET"],
                ["Public URL", Boolean(environment.publicUrl), "PUBLIC_URL"],
                [
                  environment.leadRouting
                    ? `Lead routing — ${environment.leadRouting.provider === "openai" ? "OpenAI" : "Anthropic"} (${environment.leadRouting.model})`
                    : "Lead routing",
                  Boolean(environment.leadRouting),
                  "OPENAI_API_KEY / ANTHROPIC_API_KEY",
                ],
              ].map(([label, present, variable]) => (
                <li key={variable} className={present ? "ok" : "bad"}>
                  {present ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                  {label} — <code>{variable}</code>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </main>
  );
}
