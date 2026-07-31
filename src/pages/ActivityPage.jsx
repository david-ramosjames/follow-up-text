import { MessageSquare, Octagon } from "lucide-react";
import { useEffect, useState } from "react";
import AppNav from "../components/AppNav";
import { useAdminAuth } from "../components/AdminAuth";
import {
  formatPhone,
  formatWhen,
  loadEnrollmentMessages,
  loadEnrollments,
  loadEvents,
  STATUS_LABELS,
  stopEnrollment,
} from "../lib/followups";

const FILTERS = [
  { value: "active", label: "Running" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

function Thread({ enrollmentId }) {
  const [messages, setMessages] = useState(null);

  useEffect(() => {
    loadEnrollmentMessages(enrollmentId).then(setMessages).catch(() => setMessages([]));
  }, [enrollmentId]);

  if (!messages) return <p className="thread-loading">Loading messages...</p>;
  if (!messages.length) return <p className="thread-loading">Nothing has gone out yet.</p>;

  return (
    <div className="thread">
      {messages.map((message) => (
        <div key={message.id} className={`bubble ${message.direction}`}>
          <p>{message.body}</p>
          <small>
            {message.direction === "outbound" ? "Sent" : "Received"} {formatWhen(message.created_at)}
            {message.status === "failed" && ` · failed: ${message.error ?? "unknown error"}`}
            {message.status === "undelivered" && " · not delivered"}
          </small>
        </div>
      ))}
    </div>
  );
}

export default function ActivityPage() {
  const auth = useAdminAuth();
  const [filter, setFilter] = useState("active");
  const [enrollments, setEnrollments] = useState([]);
  const [events, setEvents] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");

  const refresh = (nextFilter = filter) => {
    setStatus("loading");
    Promise.all([loadEnrollments({ status: nextFilter }), loadEvents({ limit: 40 })])
      .then(([enrollmentData, eventData]) => {
        setEnrollments(enrollmentData);
        setEvents(eventData);
        setStatus("ready");
      })
      .catch((loadError) => {
        setError(loadError.message);
        setStatus("error");
      });
  };

  useEffect(() => { refresh(filter); /* eslint-disable-next-line */ }, [filter]);

  const stop = async (enrollment) => {
    const contact = enrollment.followup_contacts;
    const confirmed = window.confirm(
      `Stop follow-ups for ${contact?.first_name || formatPhone(contact?.phone_e164)}? `
        + "No further texts will go out.",
    );
    if (!confirmed) return;
    setError("");
    try {
      await stopEnrollment(enrollment.id, auth.user?.email);
      refresh();
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
            <p>Everything running or recently ended, and the full message history behind each one.</p>
          </div>
        </header>

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
        {status === "loading" && <div className="page-state">Loading...</div>}

        {status === "ready" && enrollments.length === 0 && (
          <div className="empty-state">
            <h2>Nothing here</h2>
            <p>Paralegals start follow-ups from Slack with <code>/followup</code>.</p>
          </div>
        )}

        <div className="card-list">
          {enrollments.map((enrollment) => {
            const contact = enrollment.followup_contacts;
            const sequence = enrollment.followup_sequences;
            const open = openId === enrollment.id;
            return (
              <article key={enrollment.id} className={enrollment.status === "active" ? "live" : ""}>
                <header>
                  <div>
                    <h2>
                      {contact?.first_name || "Unknown"}{" "}
                      <span className="phone">{formatPhone(contact?.phone_e164)}</span>
                    </h2>
                    <p>
                      {sequence?.name} · {enrollment.language === "es" ? "Spanish" : "English"}
                      {enrollment.case_reference && ` · ${enrollment.case_reference}`}
                    </p>
                  </div>
                  <div className="card-status">
                    <span className={`status-dot ${enrollment.status}`}>
                      {STATUS_LABELS[enrollment.status] ?? enrollment.status}
                    </span>
                    {enrollment.status === "active" && (
                      <small>next text {formatWhen(enrollment.next_run_at, sequence?.timezone)}</small>
                    )}
                    {enrollment.status !== "active" && enrollment.ended_at && (
                      <small>ended {formatWhen(enrollment.ended_at, sequence?.timezone)}</small>
                    )}
                  </div>
                </header>

                <footer>
                  <small>
                    Assigned to <code>{enrollment.assigned_slack_user_name || enrollment.assigned_slack_user_id}</code>
                    {" · started "}{formatWhen(enrollment.started_at, sequence?.timezone)}
                    {contact?.opted_out_at && " · this contact has opted out"}
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
              {events.map((event) => (
                <li key={event.id}>
                  <time>{formatWhen(event.created_at)}</time>
                  <span>{event.kind.replace(/_/g, " ")}</span>
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
