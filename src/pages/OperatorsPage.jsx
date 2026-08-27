import { AlertTriangle, Check, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import AppNav from "../components/AppNav";
import { api, formatWhen } from "../lib/api";

const BLANK = { slack_user_id: "", email: "", display_name: "", is_supervisor: false, can_admin: false };

// Somebody added by email — which is everybody who arrived through
// BOOTSTRAP_ADMIN_EMAIL — has no Slack ID, and until they get one the bot will
// not take orders from them. Editing it in place beats re-adding them through
// the form above, which resets the supervisor and dashboard boxes to whatever
// happens to be ticked at the time.
function SlackIdCell({ person, onSave }) {
  const [draft, setDraft] = useState(person.slack_user_id ?? "");
  useEffect(() => { setDraft(person.slack_user_id ?? ""); }, [person.slack_user_id]);

  const commit = () => {
    const next = draft.trim().toUpperCase();
    if (next === (person.slack_user_id ?? "")) return;
    onSave(person, { slack_user_id: next || null });
  };

  return (
    <input
      className="inline-edit"
      value={draft}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(person.slack_user_id ?? "");
          event.currentTarget.blur();
        }
      }}
      placeholder="not in Slack"
      aria-label={`Slack member ID for ${person.display_name || person.email || "this person"}`}
    />
  );
}

// What each person can actually do, spelled out rather than left to be inferred
// from two checkboxes and a blank column.
function abilities(person) {
  const can = [];
  if (person.slack_user_id) can.push("start follow-ups in Slack");
  if (person.can_admin && person.email) can.push("sign in here");
  if (person.is_supervisor) can.push("stop anyone's series");
  return can.length ? can.join(" · ") : "nothing yet";
}

export default function OperatorsPage() {
  const [people, setPeople] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [status, setStatus] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setPeople(await api.get("/operators"));
      setStatus("ready");
    } catch (loadError) {
      setError(loadError.message);
      setStatus("error");
    }
  };

  useEffect(() => { refresh(); }, []);

  const add = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/operators", form);
      setForm(BLANK);
      await refresh();
    } catch (addError) {
      setError(addError.message);
    } finally {
      setBusy(false);
    }
  };

  const update = async (person, values) => {
    setError("");
    try {
      await api.patch(`/operators/${person.id}`, values);
      await refresh();
    } catch (saveError) {
      setError(saveError.message);
      await refresh();
    }
  };

  const remove = async (person) => {
    const who = person.display_name || person.email || person.slack_user_id;
    if (!window.confirm(
      `Remove ${who}? They lose dashboard access and can no longer start follow-ups. `
        + "Series already assigned to them keep running.",
    )) return;
    setError("");
    try {
      await api.delete(`/operators/${person.id}`);
      await refresh();
    } catch (removeError) {
      setError(removeError.message);
    }
  };

  const orphaned = people.filter((person) => person.can_admin && person.is_active && !person.email);

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Access</p>
            <h1>Who can use this</h1>
            <p>
              Shared across every firm — this is who can sign in, not whose clients
              they see. A <strong>Slack member ID</strong> lets somebody start and stop
              follow-ups from Slack, and an <strong>email address</strong> plus dashboard
              access lets them sign in here with Google. Most people need both; the
              office manager who never touches Slack needs only the email.
              Slack IDs are per workspace, so someone starting <code>/followup</code> in
              a second Slack needs that workspace's member ID on their row.
            </p>
          </div>
        </header>

        <form className="operator-form" onSubmit={add}>
          <label>
            <span>Name</span>
            <input
              value={form.display_name}
              onChange={(event) => setForm({ ...form, display_name: event.target.value })}
              placeholder="Sam Ortiz"
            />
          </label>
          <label>
            <span>Work email (Google sign-in)</span>
            <input
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="sam@firm.com"
            />
          </label>
          <label>
            <span>Slack member ID</span>
            <input
              value={form.slack_user_id}
              onChange={(event) => setForm({ ...form, slack_user_id: event.target.value })}
              placeholder="U01ABC2DEFG"
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.can_admin}
              onChange={(event) => setForm({ ...form, can_admin: event.target.checked })}
            />
            <span>Dashboard access</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.is_supervisor}
              onChange={(event) => setForm({ ...form, is_supervisor: event.target.checked })}
            />
            <span>Supervisor</span>
          </label>
          <button
            type="submit"
            className="button primary"
            disabled={busy || (!form.slack_user_id.trim() && !form.email.trim())}
          >
            <Plus size={15} /> {busy ? "Adding…" : "Add"}
          </button>
        </form>
        <p className="inline-note">
          The email must be the one they sign in to Google with. Find a Slack member ID by clicking
          the person, View full profile, then the <code>⋯</code> menu, Copy member ID.
          <strong> Supervisors</strong> can stop anyone's series and see everyone's list.
        </p>

        {error && <p className="form-error">{error}</p>}

        {orphaned.length > 0 && (
          <div className="warning-panel">
            <h2><AlertTriangle size={15} /> Access that cannot be used</h2>
            <ul>
              {orphaned.map((person) => (
                <li key={person.id}>
                  {person.display_name || person.slack_user_id} has dashboard access but no email
                  address, so there is nothing for Google sign-in to match on.
                </li>
              ))}
            </ul>
          </div>
        )}

        {status === "loading" && <div className="page-state">Loading…</div>}

        {status === "ready" && people.length === 0 && (
          <div className="empty-state">
            <h2>Nobody has access yet</h2>
            <p>Add the first person above.</p>
          </div>
        )}

        {people.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Slack ID</th>
                  <th>Can</th>
                  <th>Dashboard</th>
                  <th>Supervisor</th>
                  <th>Active</th>
                  <th>Last signed in</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.id} className={person.is_active ? "" : "muted-row"}>
                    <td>
                      <strong>{person.display_name || "—"}</strong>
                      <small>{person.email || "no email — cannot sign in"}</small>
                    </td>
                    <td><SlackIdCell person={person} onSave={update} /></td>
                    <td><small>{abilities(person)}</small></td>
                    <td>
                      <input
                        type="checkbox"
                        checked={person.can_admin}
                        onChange={(event) => update(person, { can_admin: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={person.is_supervisor}
                        onChange={(event) => update(person, { is_supervisor: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={person.is_active}
                        onChange={(event) => update(person, { is_active: event.target.checked })}
                      />
                    </td>
                    <td>
                      {person.last_seen_at
                        ? <span className="status-dot on">{formatWhen(person.last_seen_at)}</span>
                        : <span className="status-dot off">never</span>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="danger" onClick={() => remove(person)} title="Remove">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="inline-note">
          <strong>Slack ID</strong> can be typed straight into the table — it saves when you click
          away. Somebody with no Slack ID here cannot use the bot at all, which is what makes this
          list the whole allow-list.
        </p>
        <p className="inline-note">
          Turning off <strong>Active</strong> or <strong>Dashboard access</strong> ends that
          person's session on their next click — it does not wait for their cookie to expire. The
          system will not let you remove the last account that can sign in.
        </p>
      </div>
    </main>
  );
}
