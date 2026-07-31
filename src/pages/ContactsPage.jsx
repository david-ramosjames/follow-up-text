import { Ban, Search } from "lucide-react";
import { useEffect, useState } from "react";
import AppNav from "../components/AppNav";
import { formatPhone, formatWhen, loadContacts, optOutContact } from "../lib/followups";

export default function ContactsPage() {
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState("");
  const [optedOutOnly, setOptedOutOnly] = useState(false);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  const refresh = () => {
    setStatus("loading");
    loadContacts({ optedOutOnly, search })
      .then((data) => { setContacts(data); setStatus("ready"); })
      .catch((loadError) => { setError(loadError.message); setStatus("error"); });
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [optedOutOnly]);

  const optOut = async (contact) => {
    const confirmed = window.confirm(
      `Mark ${formatPhone(contact.phone_e164)} as opted out? Any running series stops and no `
        + "new one can be started. Only the client can undo this, by texting START.",
    );
    if (!confirmed) return;
    setError("");
    try {
      await optOutContact(contact.id, "staff");
      refresh();
    } catch (optOutError) {
      setError(optOutError.message);
    }
  };

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Contacts</p>
            <h1>Phone numbers</h1>
            <p>
              Opt-outs apply to the number across every sequence, which is what the rules require.
            </p>
          </div>
        </header>

        <form
          className="inline-create"
          onSubmit={(event) => { event.preventDefault(); refresh(); }}
        >
          <label>
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="512-555-0123 or a first name"
            />
          </label>
          <button type="submit"><Search size={15} /> Search</button>
        </form>

        <div className="tabs">
          <button type="button" className={!optedOutOnly ? "active" : ""} onClick={() => setOptedOutOnly(false)}>
            Everyone
          </button>
          <button type="button" className={optedOutOnly ? "active" : ""} onClick={() => setOptedOutOnly(true)}>
            Opted out
          </button>
        </div>

        {error && <p className="form-error">{error}</p>}
        {status === "loading" && <div className="page-state">Loading...</div>}

        {status === "ready" && contacts.length === 0 && (
          <div className="empty-state">
            <h2>No contacts</h2>
            <p>Numbers appear here the first time somebody starts a follow-up series for them.</p>
          </div>
        )}

        {contacts.length > 0 && (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Name</th>
                  <th>Language</th>
                  <th>Last heard from</th>
                  <th>Status</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <tr key={contact.id}>
                    <td><strong>{formatPhone(contact.phone_e164)}</strong></td>
                    <td>{[contact.first_name, contact.last_name].filter(Boolean).join(" ") || "—"}</td>
                    <td>{contact.language === "es" ? "Spanish" : "English"}</td>
                    <td>{contact.last_inbound_at ? formatWhen(contact.last_inbound_at) : "—"}</td>
                    <td>
                      {contact.opted_out_at
                        ? (
                          <span className="status-dot stopped_opt_out">
                            Opted out {formatWhen(contact.opted_out_at)}
                          </span>
                        )
                        : <span className="status-dot on">Can be texted</span>}
                    </td>
                    <td>
                      <div className="row-actions">
                        {!contact.opted_out_at && (
                          <button
                            type="button"
                            className="danger"
                            onClick={() => optOut(contact)}
                            title="Mark as opted out"
                          >
                            <Ban size={16} />
                          </button>
                        )}
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
