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

  const load = async () => {
    try {
      const data = await api.get("/settings");
      setDefinitions(data.definitions);
      setValues(data.values);
      setNumbers(data.numbers);
      setEnvironment(data.environment);
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
      setValues(await api.put("/settings", values));
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
              <option value="">No default — every sequence must pick its own</option>
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
              Everything here is stored in the database and takes effect without a redeploy. Only
              secrets live in environment variables — see <Link to="/help">Help</Link>.
            </p>
          </div>
        </header>

        {error && <p className="form-error">{error}</p>}
        {saved && <p className="form-ok">{saved}</p>}

        <section className="editor-section">
          <div>
            <h2>Quo numbers</h2>
            <p>Pulled from your Quo workspace. Each sequence picks which one it sends from.</p>
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

            {group(["default_quo_number_id"])}
          </div>
        </section>

        <section className="editor-section">
          <div>
            <h2>Firm</h2>
            <p>Used in message copy and in how times are shown.</p>
          </div>
          <div className="editor-fields">{group(["firm_name", "default_timezone"])}</div>
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
            <h2>Sending</h2>
            <p>How often texts go out and how hard the system tries.</p>
          </div>
          <div className="editor-fields">
            {group([
              "send_stop_confirmation", "dispatch_interval_seconds", "dispatch_batch_size",
              "max_send_attempts", "retry_delay_minutes",
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
                ["Sign in with Slack", environment.slackSignInConfigured, "SLACK_CLIENT_ID / SECRET"],
                ["Public URL", Boolean(environment.publicUrl), "PUBLIC_URL"],
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
