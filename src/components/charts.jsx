import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatDay } from "../lib/api";

// Charts are inline SVG, sized to their container. No chart library: the two
// forms this dashboard needs are small, and a library would cost more than it
// saves.
function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(640);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect?.width;
      if (next && Math.abs(next - width) > 1) setWidth(next);
    });
    observer.observe(element);
    setWidth(element.clientWidth || 640);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [ref, width];
}

function compact(value) {
  const number = Number(value) || 0;
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 10_000) return `${Math.round(number / 1000)}K`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(number);
}

// Round the axis top to something a person would say, so ticks land on clean
// numbers instead of 37, 74, 111.
function niceMax(value) {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

/* -------------------------------------------------------------- stat tile */

export function StatTile({ label, value, detail, tone = "neutral" }) {
  return (
    <div className={`stat-tile tone-${tone}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{typeof value === "number" ? compact(value) : value}</p>
      {detail && <p className="stat-detail">{detail}</p>}
    </div>
  );
}

/* ------------------------------------------------------- daily time series */

export function DailyChart({ data, height = 240 }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);

  const points = data ?? [];
  if (!points.length) {
    return <div className="chart-empty" ref={ref}>Nothing has been sent yet.</div>;
  }

  const padding = { top: 16, right: 58, bottom: 26, left: 38 };
  const plotWidth = Math.max(60, width - padding.left - padding.right);
  const plotHeight = height - padding.top - padding.bottom;

  const peak = Math.max(1, ...points.map((point) => Math.max(Number(point.sent), Number(point.replies))));
  const top = niceMax(peak);

  const x = (index) => padding.left + (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
  const y = (value) => padding.top + plotHeight - (Number(value) / top) * plotHeight;

  const path = (key) => points.map((point, index) => `${index ? "L" : "M"}${x(index)} ${y(point[key])}`).join(" ");

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(top * fraction));
  const uniqueTicks = [...new Set(ticks)];

  // Five date labels at most, so they never collide at narrow widths.
  const labelEvery = Math.max(1, Math.ceil(points.length / 5));

  const last = points[points.length - 1];

  const onMove = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - box.left - padding.left;
    const index = Math.round((offset / plotWidth) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  };

  return (
    <div className="chart" ref={ref}>
      <div className="chart-legend">
        <span><i style={{ background: "var(--series-1)" }} /> Texts sent</span>
        <span><i style={{ background: "var(--series-2)" }} /> Replies from clients in a series</span>
      </div>

      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Texts sent, and replies from clients in a follow-up series, per day. ${points.length} days shown.`}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {uniqueTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={padding.left} x2={padding.left + plotWidth}
              y1={y(tick)} y2={y(tick)}
              stroke={tick === 0 ? "var(--chart-axis)" : "var(--chart-grid)"}
              strokeWidth="1"
            />
            <text x={padding.left - 8} y={y(tick) + 4} textAnchor="end" className="chart-tick">{compact(tick)}</text>
          </g>
        ))}

        {points.map((point, index) => (
          index % labelEvery === 0 || index === points.length - 1 ? (
            <text key={point.day} x={x(index)} y={height - 8} textAnchor="middle" className="chart-tick">
              {formatDay(point.day)}
            </text>
          ) : null
        ))}

        <path d={path("sent")} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={path("replies")} fill="none" stroke="var(--series-2)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

        {hover !== null && (
          <line
            x1={x(hover)} x2={x(hover)} y1={padding.top} y2={padding.top + plotHeight}
            stroke="var(--chart-axis)" strokeWidth="1"
          />
        )}

        {/* End dots carry a surface ring so they stay legible where the two
            series cross at the right edge. */}
        {[["sent", "var(--series-1)"], ["replies", "var(--series-2)"]].map(([key, colour]) => (
          <circle
            key={key}
            cx={x(points.length - 1)} cy={y(last[key])} r="4"
            fill={colour} stroke="var(--chart-surface)" strokeWidth="2"
          />
        ))}

        {hover !== null && [["sent", "var(--series-1)"], ["replies", "var(--series-2)"]].map(([key, colour]) => (
          <circle
            key={`hover-${key}`}
            cx={x(hover)} cy={y(points[hover][key])} r="4"
            fill={colour} stroke="var(--chart-surface)" strokeWidth="2"
          />
        ))}

        <text x={x(points.length - 1) + 10} y={y(last.sent) + 4} className="chart-end-label">
          {compact(last.sent)}
        </text>
        <text x={x(points.length - 1) + 10} y={y(last.replies) + 4} className="chart-end-label">
          {compact(last.replies)}
        </text>
      </svg>

      {hover !== null && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(Math.max(x(hover), 70), width - 70) }}
        >
          <strong>{formatDay(points[hover].day)}</strong>
          <span><i style={{ background: "var(--series-1)" }} /> {points[hover].sent} sent</span>
          <span><i style={{ background: "var(--series-2)" }} /> {points[hover].replies} replies in series</span>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------- per-sequence outcomes */

// One series (re-engagement rate), so no legend: the heading says what is
// plotted, and every bar is directly labelled.
export function SequenceBars({ sequences }) {
  const rows = (sequences ?? []).filter((row) => Number(row.started) > 0);
  if (!rows.length) {
    return <div className="chart-empty">No series have been started in this period.</div>;
  }

  return (
    <div className="rate-bars">
      {rows.map((row) => {
        const started = Number(row.started);
        const reengaged = Number(row.reengaged);
        const rate = started ? Math.round((reengaged / started) * 100) : 0;
        return (
          <div key={row.id} className="rate-row">
            <div className="rate-label">
              <strong>{row.name}</strong>
              <small>
                {started} started · {reengaged} came back · {row.opted_out} opted out
                {Number(row.active) > 0 && ` · ${row.active} running`}
              </small>
            </div>
            <div className="rate-track" role="img" aria-label={`${rate} percent came back`}>
              <div className="rate-fill" style={{ width: `${Math.max(rate, rate > 0 ? 2 : 0)}%` }} />
            </div>
            <span className="rate-value">{rate}%</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------- step breakdown */

// Which text in a sequence actually earns the reply. This is the number that
// decides whether six texts is right or whether three would do.
export function StepBars({ steps, sequenceSlug }) {
  const rows = (steps ?? []).filter((step) => step.sequence_slug === sequenceSlug);
  if (!rows.length) return null;

  const peak = Math.max(1, ...rows.map((step) => Number(step.sent)));

  return (
    <div className="step-bars">
      {rows.map((step) => (
        <div key={`${step.sequence_slug}-${step.position}`} className="step-row">
          <span className="step-name">{step.position}. {step.label || "Untitled"}</span>
          <div className="step-track">
            <div className="step-fill" style={{ width: `${(Number(step.sent) / peak) * 100}%` }} />
          </div>
          <span className="step-value">{step.sent}</span>
        </div>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- polling helper */

export function useInterval(handler, ms) {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(() => {
    if (!ms) return undefined;
    const timer = setInterval(() => saved.current(), ms);
    return () => clearInterval(timer);
  }, [ms]);
}
