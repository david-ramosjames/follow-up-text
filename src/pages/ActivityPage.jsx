import { MessageSquare, Octagon, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import AppNav from "../components/AppNav";
import { api, formatWhen, SOURCE_LABELS, STATUS_LABELS } from "../lib/api";
import { formatPhone } from "../../shared/messaging";

const FILTERS = [
  { value: "active", label: "Running" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

function Thread({ enrollmentId }) {
  const [messages, setMessages] = useState(null);

  useEffect(() => {
    api.get(`/enrollments/${enrollmentId}/messages`).then(setMessages).catch(() => setMessages([]));
  }, [enrollmentId]);

  if (!messages) return <p className="thread-loading">Loading messages…</p>;
  if (!messages.length) return <p className="thread-loading">Nothing has gone out yet.</p>;

  return (
    <div className="thread">
      {messages.map((message) => (
        <div key={message.id} className={`bubble ${message.direction}`}>
          <p>{message.body}</p>
          <small>
            {message.direction === "outbound" ? "Sent" : "Received"} {formatWhen(message.created_at)}
            {message.segments > 1 && ` · ${message.segments} segments`}
            {message.status === "failed" && ` · failed: ${message.error ?? "unknown error"}`}
            {message.status === "undelivered" && " · never arrived"}
            {message.status === "delivered" && " · delivered"}
          </small>
        </div>
      ))}
    </div>
  );
}

export default function ActivityPage() {
  const [filter, setFilter] = useState("active");
  const [search, setSearch] = useState("");
  const [enrollments, setEnrollments] = useState([]);
  const [events, setEvents] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  const refresh = useCallback(async (nextFilter = filter, nextSearch = search) => {
    setStatus("loading");
    try {
      const query = `?status=${nextFilter}${nextSearch ? `&search=${encodeURIComponent(nextSearch)}` : ""}`;
      const [enrollmentData, eventData] = await Promise.all([
        api.get(`/enrollments${query}`),
        api.get("/events"),
      ]);
      setEnrollments(enrollmentData);
      setEvents(eventData);
      setStatus("ready");
    } catch (loadError) {
      setError(loadError.message);
      setStatus("error");
    }
  }, [filter, search]);

  useEffect(() => { refresh(filter, search); /* eslint-disable-next-line */ }, [filter]);

  const stop = async (enrollment) => {
    const confirmed = window.confirm(
      `Stop follow-ups for ${enrollment.first_name || formatPhone(enrollment.phone_e164)}? `
        + "No further texts will go out.",
    );
    if (!confirmed) return;
    setError("");
    try {
      await api.post(`/enrollments/${enrollment.id}/stop`);
      await refresh();
    } catch (stopError) {
      setError(stopError.message);
    }
  };

  return (
    <main className="page">
      <div className="shell">
        <AppNav />

        <header className="page-heading">
          <div>
            <p className="eyebrow">Activity</p>
            <h1>Follow-up series</h1>
            <p>Everything running or recently ended, with the full message history behind each one.</p>
          </div>
        </header>

        <form className="inline-create" onSubmit={(event) => { event.preventDefault(); refresh(); }}>
          <label>
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="512-555-0123 or a first name"
            />
          </label>
          <button type="submit" className="button primary"><Search size={15} /> Search</button>
        </form>

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
        {status === "loading" && <div className="page-state">Loading…</div>}

        {status === "ready" && enrollments.length === 0 && (
          <div className="empty-state">
            <h2>Nothing here</h2>
            <p>Paralegals start follow-ups from Slack — with <code>/followup</code>, or from the
              <code> ⋯ </code> menu on any message.</p>
          </div>
        )}

        <div className="card-list">
          {enrollments.map((enrollment) => {
            const open = openId === enrollment.id;
            return (
              <article key={enrollment.id} className={enrollment.status === "active" ? "live" : ""}>
                <header>
                  <div>
                    <h2>
                      {enrollment.first_name || "Unknown"}{" "}
                      <span className="phone">{formatPhone(enrollment.phone_e164)}</span>
                    </h2>
                    <p>
                      {enrollment.sequence_name} · {enrollment.language === "es" ? "Spanish" : "English"}
                      {enrollment.case_reference && ` · ${enrollment.case_reference}`}
                    </p>
                  </div>
                  <div className="card-status">
                    <span className={`status-dot ${enrollment.status}`}>
                      {STATUS_LABELS[enrollment.status] ?? enrollment.status}
                    </span>
                    {enrollment.status === "active"
                      ? <small>next text {formatWhen(enrollment.next_run_at, enrollment.timezone)}</small>
                      : enrollment.ended_at && <small>ended {formatWhen(enrollment.ended_at, enrollment.timezone)}</small>}
                  </div>
                </header>

                <footer>
                  <small>
                    {enrollment.sent_count} text{Number(enrollment.sent_count) === 1 ? "" : "s"} sent ·
                    {" "}assigned to <code>{enrollment.assigned_slack_user_name || enrollment.assigned_slack_user_id}</code> ·
                    {" "}{SOURCE_LABELS[enrollment.source] ?? enrollment.source} ·
                    {" "}started {formatWhen(enrollment.started_at, enrollment.timezone)}
                    {enrollment.opted_out_at && " · this contact has opted out"}
                  </small>
                  <div className="card-actions">
                    <button type="button" onClick={() => setOpenId(open ? null : enrollment.id)}>
                      <MessageSquare size={14} /> {open ? "Hide messages" : "Messages"}
                    </button>
                    {enrollment.status === "active" && (
                      <button type="button" className="danger" onClick={() => stop(enrollment)}>
                        <Octagon size={14} /> Stop
                      </button>
                    )}
                  </div>
                </footer>

                {open && <Thread enrollmentId={enrollment.id} />}
              </article>
            );
          })}
        </div>

        {events.length > 0 && (
          <section className="log">
            <h2>Recent events</h2>
            <ul>
              {events.slice(0, 40).map((event) => (
                <li key={event.id}>
                  <time>{formatWhen(event.created_at)}</time>
                  <span>
                    {event.kind.replace(/_/g, " ")}
                    {event.phone_e164 && ` — ${event.first_name || formatPhone(event.phone_e164)}`}
                  </span>
                  <small>{event.actor}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}
