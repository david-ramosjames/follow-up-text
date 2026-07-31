import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import AppNav from "../components/AppNav";
import { api, formatWhen } from "../lib/api";

const BLANK = { slack_user_id: "", display_name: "", email: "", is_supervisor: false, can_admin: false };

export default function OperatorsPage() {
  const [operators, setOperators] = useState([]);
  const [form, setForm] = useState(BLANK);
  const [status, setStatus] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = async () => {
    try {
      setOperators(await api.get("/operators"));
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

  const update = async (operator, values) => {
    setError("");
    try {
      await api.patch(`/operators/${operator.slack_user_id}`, values);
      await refresh();
    } catch (saveError) {
      setError(saveError.message);
      await refresh();
    }
  };

  const remove = async (operator) => {
    const confirmed = window.confirm(
      `Remove ${operator.display_name || operator.slack_user_id}? They will no longer be able to `
        + "start or stop follow-ups from Slack. Series already assigned to them keep running.",
    );
    if (!confirmed) return;
    setError("");
    try {
      await api.delete(`/operators/${operator.slack_user_id}`);
      await refresh();
    } catch (removeError) {
      setError(removeError.message);
    }
  };

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Access</p>
            <h1>Operators</h1>
            <p>
              The Slack accounts allowed to start follow-ups. Nobody else can, and a series can only
              be stopped by the person it is assigned to — or by a supervisor.
            </p>
          </div>
        </header>

        <form className="operator-form" onSubmit={add}>
          <label>
            <span>Slack member ID</span>
            <input
              value={form.slack_user_id}
              onChange={(event) => setForm({ ...form, slack_user_id: event.target.value })}
              placeholder="U01ABC2DEFG"
            />
          </label>
          <label>
            <span>Name</span>
            <input
              value={form.display_name}
              onChange={(event) => setForm({ ...form, display_name: event.target.value })}
              placeholder="Sam Ortiz"
            />
          </label>
          <label>
            <span>Email (optional)</span>
            <input
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              placeholder="sam@firm.com"
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.is_supervisor}
              onChange={(event) => setForm({ ...form, is_supervisor: event.target.checked })}
            />
            <span>Supervisor</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.can_admin}
              onChange={(event) => setForm({ ...form, can_admin: event.target.checked })}
            />
            <span>Dashboard access</span>
          </label>
          <button type="submit" className="button primary" disabled={busy || !form.slack_user_id.trim()}>
            <Plus size={15} /> {busy ? "Adding…" : "Add"}
          </button>
        </form>
        <p className="inline-note">
          Find a member ID in Slack: click the person, View full profile, then the <code>⋯</code>
          {" "}menu, Copy member ID. <strong>Supervisors</strong> can stop anyone's series and see
          everyone's list. <strong>Dashboard access</strong> lets them sign in here.
        </p>

        {error && <p className="form-error">{error}</p>}
        {status === "loading" && <div className="page-state">Loading…</div>}

        {status === "ready" && operators.length === 0 && (
          <div className="empty-state">
            <h2>Nobody can start follow-ups yet</h2>
            <p>Add at least one Slack account above.</p>
          </div>
        )}

        {operators.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Slack ID</th>
                  <th>Supervisor</th>
                  <th>Dashboard</th>
                  <th>Active</th>
                  <th>Last signed in</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {operators.map((operator) => (
                  <tr key={operator.slack_user_id}>
                    <td>
                      <strong>{operator.display_name || "—"}</strong>
                      {operator.email && <small>{operator.email}</small>}
                    </td>
                    <td><code>{operator.slack_user_id}</code></td>
                    <td>
                      <input
                        type="checkbox"
                        checked={operator.is_supervisor}
                        onChange={(event) => update(operator, { is_supervisor: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={operator.can_admin}
                        onChange={(event) => update(operator, { can_admin: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={operator.is_active}
                        onChange={(event) => update(operator, { is_active: event.target.checked })}
                      />
                    </td>
                    <td>{operator.last_seen_at ? formatWhen(operator.last_seen_at) : "—"}</td>
                    <td>
                      <div className="row-actions">
                        <button type="button" className="danger" onClick={() => remove(operator)} title="Remove">
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
      </div>
    </main>
  );
}
