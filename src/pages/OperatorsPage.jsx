import { Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import AppNav from "../components/AppNav";
import { addOperator, loadOperators, removeOperator, saveOperator } from "../lib/followups";

export default function OperatorsPage() {
  const [operators, setOperators] = useState([]);
  const [form, setForm] = useState({ slack_user_id: "", display_name: "", email: "", is_supervisor: false });
  const [status, setStatus] = useState("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => loadOperators()
    .then((data) => { setOperators(data); setStatus("ready"); })
    .catch((loadError) => { setError(loadError.message); setStatus("error"); });

  useEffect(() => { refresh(); }, []);

  const add = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await addOperator({
        slack_user_id: form.slack_user_id,
        display_name: form.display_name.trim() || null,
        email: form.email.trim().toLowerCase() || null,
        is_supervisor: form.is_supervisor,
      });
      setForm({ slack_user_id: "", display_name: "", email: "", is_supervisor: false });
      await refresh();
    } catch (addError) {
      setError(addError.code === "23505"
        ? "That Slack account is already on the list."
        : addError.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (operator, values) => {
    setError("");
    try {
      await saveOperator(operator.slack_user_id, values);
      await refresh();
    } catch (saveError) {
      setError(saveError.message);
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
      await removeOperator(operator.slack_user_id);
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
              The Slack accounts allowed to run <code>/followup</code>. Nobody else can start a series,
              and a series can only be stopped by the person it is assigned to — or by a supervisor.
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
          <button type="submit" disabled={busy || !form.slack_user_id.trim()}>
            <Plus size={15} /> {busy ? "Adding..." : "Add"}
          </button>
        </form>
        <p className="inline-note">
          Find a member ID in Slack under the person's profile → View full profile → More → Copy member ID.
          Supervisors can stop any series and see everyone's list; everyone else sees only their own.
        </p>

        {error && <p className="form-error">{error}</p>}
        {status === "loading" && <div className="page-state">Loading...</div>}

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
                  <th>Active</th>
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
                        onChange={(event) => toggle(operator, { is_supervisor: event.target.checked })}
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={operator.is_active}
                        onChange={(event) => toggle(operator, { is_active: event.target.checked })}
                      />
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="danger"
                          onClick={() => remove(operator)}
                          title="Remove"
                        >
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
