// ---------------------------------------------------------------------------
// FoodDonationScheduler — a single self-contained React component that lets
// volunteers/donors pick a day to drop off a food donation, and lets staff
// see who is bringing what and when.
//
// Data lives in a Google Sheet behind a Google Apps Script web app. Paste
// your deployed /exec URL below before using this component.
//
// Expected Apps Script contract:
//   GET  <url>                                  -> { ok, cap, signups: [{ id, date, fullName, email, items, createdAt }] }
//   POST <url>  { fullName, email, items, date }        -> { ok: true } | { ok: false, error }
//   POST <url>  { action: "delete", id }                -> { ok: true } | { ok: false, error }
// The server is the source of truth for the daily cap and the duplicate-
// email rule — this component only mirrors that logic for a responsive UI
// and always defers to the server's response.
//
// CORS note: Apps Script doesn't answer CORS preflight requests, so every
// POST below is sent with Content-Type "text/plain;charset=utf-8" (still a
// JSON string body) to keep it a "simple request" the browser won't preflight.
// ---------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";

// TODO: paste your deployed Google Apps Script web app URL here.
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwdjKk_PKsK-SsMU8RvJ9T4b867SKULTzu9s-h47g2YmYQUqNsrGZih3Vr-Co7IjiD4oQ/exec";

const DEFAULT_CAP = 5;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODate(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

function todayISO() {
  const d = new Date();
  return toISODate(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function firstWeekdayOfMonth(year, month) {
  return new Date(year, month, 1).getDay();
}

function formatDateLong(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

async function postToSheet(payload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export default function FoodDonationScheduler() {
  const today = todayISO();
  const now = new Date();

  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());

  const [signups, setSignups] = useState([]);
  const [cap, setCap] = useState(DEFAULT_CAP);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  const [selectedDate, setSelectedDate] = useState(null);

  const [formState, setFormState] = useState({ fullName: "", email: "", items: "" });
  const [formErrors, setFormErrors] = useState({});
  const [formBanner, setFormBanner] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const [removingId, setRemovingId] = useState(null);
  const [removeError, setRemoveError] = useState("");
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    fetch(APPS_SCRIPT_URL)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data && data.ok) {
          setSignups(data.signups || []);
          setCap(data.cap || DEFAULT_CAP);
        } else {
          setLoadError((data && data.error) || "Couldn't load the sign-up sheet.");
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError("Couldn't reach the server. Check your connection and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadTick]);

  const countsByDate = useMemo(() => {
    const counts = {};
    for (const s of signups) counts[s.date] = (counts[s.date] || 0) + 1;
    return counts;
  }, [signups]);

  const signupsForSelected = useMemo(() => {
    if (!selectedDate) return [];
    return signups
      .filter((s) => s.date === selectedDate)
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
  }, [signups, selectedDate]);

  const selectedCount = selectedDate ? countsByDate[selectedDate] || 0 : 0;
  const selectedIsFull = selectedCount >= cap;
  const selectedIsPast = selectedDate ? selectedDate < today : false;

  function goToMonth(delta) {
    let y = viewYear;
    let m = viewMonth + delta;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    setViewYear(y);
    setViewMonth(m);
  }

  function openDay(iso, isPast) {
    if (isPast) return;
    setSelectedDate(iso);
    setFormState({ fullName: "", email: "", items: "" });
    setFormErrors({});
    setFormBanner("");
    setConfirmation("");
    setRemovingId(null);
    setRemoveError("");
  }

  function closePanel() {
    setSelectedDate(null);
  }

  function validateForm() {
    const errors = {};
    if (!formState.fullName.trim()) errors.fullName = "Please enter your name.";
    if (!formState.email.trim()) errors.email = "Please enter your email.";
    else if (!EMAIL_RE.test(formState.email.trim())) errors.email = "Please enter a valid email address.";
    return errors;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (selectedIsFull || selectedIsPast || !selectedDate) return;

    const errors = validateForm();
    setFormErrors(errors);
    setFormBanner("");
    if (Object.keys(errors).length) return;

    setSubmitting(true);
    try {
      const payload = {
        fullName: formState.fullName.trim(),
        email: formState.email.trim(),
        items: formState.items.trim(),
        date: selectedDate,
      };
      const result = await postToSheet(payload);
      if (result && result.ok) {
        const newSignup = {
          // Some Apps Script deployments echo back the created row's id;
          // fall back to a client id so the calendar can update optimistically either way.
          id: result.id || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          date: payload.date,
          fullName: payload.fullName,
          email: payload.email,
          items: payload.items,
          createdAt: new Date().toISOString(),
        };
        setSignups((prev) => [...prev, newSignup]);
        setConfirmation(`Thanks, ${newSignup.fullName}! You're signed up for ${formatDateLong(selectedDate)}.`);
        setFormState({ fullName: "", email: "", items: "" });
      } else {
        setFormBanner((result && result.error) || "Something went wrong. Please try again.");
      }
    } catch (err) {
      setFormBanner("Network error — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  function startRemove(id) {
    setRemovingId(id);
    setRemoveError("");
  }

  function cancelRemove() {
    setRemovingId(null);
    setRemoveError("");
  }

  async function confirmRemove(id) {
    setRemoving(true);
    setRemoveError("");
    try {
      const result = await postToSheet({ action: "delete", id });
      if (result && result.ok) {
        setSignups((prev) => prev.filter((s) => s.id !== id));
        setRemovingId(null);
      } else {
        setRemoveError((result && result.error) || "Couldn't remove that sign-up.");
      }
    } catch (err) {
      setRemoveError("Network error — please try again.");
    } finally {
      setRemoving(false);
    }
  }

  const weeks = useMemo(() => {
    const total = daysInMonth(viewYear, viewMonth);
    const offset = firstWeekdayOfMonth(viewYear, viewMonth);
    const cells = [];
    for (let i = 0; i < offset; i++) cells.push(null);
    for (let day = 1; day <= total; day++) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);
    const rows = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [viewYear, viewMonth]);

  return (
    <div className="fds-root">
      <style>{CSS}</style>

      <header className="fds-header">
        <h1>Food Donation Sign-Up</h1>
        <p>Pick a day to drop off your donation — we cap each day at {cap} donors so the pantry stays balanced.</p>
      </header>

      {loading && <div className="fds-banner fds-banner--info">Loading the calendar…</div>}

      {!loading && loadError && (
        <div className="fds-banner fds-banner--error">
          {loadError}{" "}
          <button className="fds-link-btn" onClick={() => setReloadTick((t) => t + 1)}>
            Retry
          </button>
        </div>
      )}

      {!loading && !loadError && (
        <>
          <div className="fds-legend">
            <span className="fds-legend-item"><i className="fds-swatch fds-swatch--open" /> Open</span>
            <span className="fds-legend-item"><i className="fds-swatch fds-swatch--partial" /> Filling up</span>
            <span className="fds-legend-item"><i className="fds-swatch fds-swatch--full" /> Full</span>
            <span className="fds-legend-item"><i className="fds-swatch fds-swatch--past" /> Past</span>
          </div>

          <div className="fds-calendar">
            <div className="fds-cal-nav">
              <button className="fds-nav-btn" onClick={() => goToMonth(-1)} aria-label="Previous month">‹</button>
              <div className="fds-cal-title">{MONTH_LABELS[viewMonth]} {viewYear}</div>
              <button className="fds-nav-btn" onClick={() => goToMonth(1)} aria-label="Next month">›</button>
            </div>

            <div className="fds-weekday-row">
              {WEEKDAY_LABELS.map((w) => (
                <div key={w} className="fds-weekday">{w}</div>
              ))}
            </div>

            {weeks.map((week, wi) => (
              <div className="fds-week-row" key={wi}>
                {week.map((day, di) => {
                  if (day === null) return <div className="fds-day fds-day--empty" key={di} />;
                  const iso = toISODate(viewYear, viewMonth, day);
                  const count = countsByDate[iso] || 0;
                  const isPast = iso < today;
                  const isToday = iso === today;
                  const isFull = count >= cap;
                  let status = "open";
                  if (isPast) status = "past";
                  else if (isFull) status = "full";
                  else if (count > 0) status = "partial";

                  return (
                    <button
                      key={di}
                      type="button"
                      className={`fds-day fds-day--${status}${isToday ? " fds-day--today" : ""}`}
                      onClick={() => openDay(iso, isPast)}
                      disabled={isPast}
                      aria-label={`${formatDateLong(iso)}, ${count} of ${cap} signed up${isFull ? ", full" : ""}`}
                    >
                      <span className="fds-day-num">{day}</span>
                      {count > 0 && (
                        <span className="fds-day-count">{isFull ? "Full" : `${count}/${cap}`}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}

      {selectedDate && (
        <div className="fds-modal-backdrop" onClick={closePanel}>
          <div className="fds-modal" onClick={(e) => e.stopPropagation()}>
            <div className="fds-modal-header">
              <h2>{formatDateLong(selectedDate)}</h2>
              <button className="fds-close-btn" onClick={closePanel} aria-label="Close">×</button>
            </div>

            <section className="fds-day-list">
              <h3>Who's signed up ({signupsForSelected.length}/{cap})</h3>
              {signupsForSelected.length === 0 && (
                <p className="fds-empty-state">No one has signed up for this day yet — be the first!</p>
              )}
              <ul>
                {signupsForSelected.map((s) => (
                  <li key={s.id} className="fds-signup-row">
                    <div className="fds-signup-info">
                      <strong>{s.fullName}</strong>
                      <span className="fds-signup-email">{s.email}</span>
                      {s.items && <span className="fds-signup-items">{s.items}</span>}
                    </div>

                    {removingId === s.id ? (
                      <div className="fds-remove-confirm">
                        <button
                          className="fds-secondary-btn"
                          disabled={removing}
                          onClick={() => confirmRemove(s.id)}
                        >
                          {removing ? "Removing…" : "Confirm"}
                        </button>
                        <button className="fds-text-btn" onClick={cancelRemove} disabled={removing}>
                          Cancel
                        </button>
                        {removeError && <div className="fds-field-error">{removeError}</div>}
                      </div>
                    ) : (
                      <button className="fds-text-btn fds-remove-btn" onClick={() => startRemove(s.id)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section className="fds-signup-form">
              {selectedIsPast ? (
                <p className="fds-empty-state">This date has passed.</p>
              ) : confirmation ? (
                <div className="fds-banner fds-banner--success">{confirmation}</div>
              ) : selectedIsFull ? (
                <div className="fds-banner fds-banner--full">
                  This day is full. Please pick another date.
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate>
                  <h3>Sign up for this day</h3>
                  {formBanner && <div className="fds-banner fds-banner--error">{formBanner}</div>}

                  <label className="fds-field">
                    <span>Full name</span>
                    <input
                      type="text"
                      value={formState.fullName}
                      onChange={(e) => setFormState((f) => ({ ...f, fullName: e.target.value }))}
                    />
                    {formErrors.fullName && <div className="fds-field-error">{formErrors.fullName}</div>}
                  </label>

                  <label className="fds-field">
                    <span>Email address</span>
                    <input
                      type="email"
                      value={formState.email}
                      onChange={(e) => setFormState((f) => ({ ...f, email: e.target.value }))}
                    />
                    {formErrors.email && <div className="fds-field-error">{formErrors.email}</div>}
                  </label>

                  <label className="fds-field">
                    <span>Donation items <em>(optional)</em></span>
                    <input
                      type="text"
                      placeholder="e.g. 2 boxes of pasta, canned vegetables"
                      value={formState.items}
                      onChange={(e) => setFormState((f) => ({ ...f, items: e.target.value }))}
                    />
                  </label>

                  <button type="submit" className="fds-primary-btn" disabled={submitting}>
                    {submitting ? "Signing up…" : "Sign Up"}
                  </button>
                </form>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

const CSS = `
.fds-root {
  --fds-bg: #fff8f0;
  --fds-ink: #3a2e26;
  --fds-muted: #8a7c70;
  --fds-accent: #e07a3f;
  --fds-accent-dark: #c1602a;
  --fds-open: #eaf7ef;
  --fds-open-border: #63b787;
  --fds-partial: #fff4d9;
  --fds-partial-border: #e8ac2e;
  --fds-full: #fbe9e9;
  --fds-full-border: #d9605f;
  --fds-past: #eeeae5;
  --fds-past-border: #cabfb2;
  --fds-radius: 14px;

  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--fds-bg);
  color: var(--fds-ink);
  max-width: 720px;
  margin: 0 auto;
  padding: 16px;
  box-sizing: border-box;
}
.fds-root * { box-sizing: border-box; }

.fds-header h1 { font-size: 1.5rem; margin: 0 0 4px; }
.fds-header p { margin: 0 0 16px; color: var(--fds-muted); font-size: 0.95rem; }

.fds-banner {
  padding: 12px 14px;
  border-radius: var(--fds-radius);
  margin-bottom: 14px;
  font-size: 0.95rem;
}
.fds-banner--info { background: #eef2f7; color: #375a7f; }
.fds-banner--error { background: var(--fds-full); color: #9c3a3a; }
.fds-banner--success { background: var(--fds-open); color: #2f7250; }
.fds-banner--full { background: var(--fds-full); color: #9c3a3a; padding: 14px; border-radius: var(--fds-radius); }

.fds-link-btn {
  background: none;
  border: none;
  color: inherit;
  text-decoration: underline;
  font: inherit;
  cursor: pointer;
  padding: 0;
}

.fds-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
  font-size: 0.85rem;
  color: var(--fds-muted);
}
.fds-legend-item { display: inline-flex; align-items: center; gap: 6px; }
.fds-swatch { width: 14px; height: 14px; border-radius: 4px; display: inline-block; border: 1px solid; }
.fds-swatch--open { background: var(--fds-open); border-color: var(--fds-open-border); }
.fds-swatch--partial { background: var(--fds-partial); border-color: var(--fds-partial-border); }
.fds-swatch--full { background: var(--fds-full); border-color: var(--fds-full-border); }
.fds-swatch--past { background: var(--fds-past); border-color: var(--fds-past-border); }

.fds-calendar {
  background: #fff;
  border-radius: var(--fds-radius);
  padding: 12px;
  box-shadow: 0 2px 10px rgba(60, 40, 20, 0.06);
}

.fds-cal-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.fds-cal-title { font-weight: 700; font-size: 1.1rem; }
.fds-nav-btn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: var(--fds-bg);
  color: var(--fds-accent-dark);
  font-size: 1.4rem;
  cursor: pointer;
}
.fds-nav-btn:hover { background: #f3e2d2; }

.fds-weekday-row, .fds-week-row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 4px;
}
.fds-weekday {
  text-align: center;
  font-size: 0.75rem;
  color: var(--fds-muted);
  padding: 4px 0;
  font-weight: 600;
}
.fds-week-row { margin-bottom: 4px; }

.fds-day {
  min-height: 52px;
  border-radius: 10px;
  border: 1.5px solid transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  cursor: pointer;
  font: inherit;
  padding: 4px;
}
.fds-day--empty { visibility: hidden; }
.fds-day-num { font-size: 0.95rem; font-weight: 600; }
.fds-day-count { font-size: 0.65rem; color: var(--fds-muted); }

.fds-day--open { background: var(--fds-open); border-color: var(--fds-open-border); }
.fds-day--partial { background: var(--fds-partial); border-color: var(--fds-partial-border); }
.fds-day--full { background: var(--fds-full); border-color: var(--fds-full-border); }
.fds-day--full .fds-day-count { color: #9c3a3a; font-weight: 700; }
.fds-day--past { background: var(--fds-past); border-color: var(--fds-past-border); color: #a89e92; cursor: not-allowed; }
.fds-day--today { outline: 2px solid var(--fds-accent); outline-offset: -2px; }

.fds-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(40, 28, 18, 0.45);
  display: flex;
  align-items: flex-end;
  justify-content: center;
  z-index: 50;
  padding: 0;
}
@media (min-width: 640px) {
  .fds-modal-backdrop { align-items: center; padding: 20px; }
}

.fds-modal {
  background: #fff;
  width: 100%;
  max-width: 480px;
  max-height: 92vh;
  overflow-y: auto;
  border-radius: 18px 18px 0 0;
  padding: 18px;
}
@media (min-width: 640px) {
  .fds-modal { border-radius: var(--fds-radius); }
}

.fds-modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.fds-modal-header h2 { font-size: 1.15rem; margin: 0; }
.fds-close-btn {
  border: none;
  background: var(--fds-bg);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 1.3rem;
  cursor: pointer;
  color: var(--fds-muted);
  flex-shrink: 0;
}

.fds-day-list h3, .fds-signup-form h3 { font-size: 1rem; margin: 14px 0 8px; }
.fds-empty-state { color: var(--fds-muted); font-size: 0.9rem; }

.fds-day-list ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.fds-signup-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--fds-bg);
  border-radius: 10px;
  padding: 10px 12px;
  flex-wrap: wrap;
}
.fds-signup-info { display: flex; flex-direction: column; font-size: 0.9rem; }
.fds-signup-email, .fds-signup-items { color: var(--fds-muted); font-size: 0.8rem; }

.fds-text-btn {
  background: none;
  border: none;
  color: var(--fds-accent-dark);
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
  padding: 6px 4px;
}
.fds-remove-btn { text-decoration: underline; }

.fds-remove-confirm { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

.fds-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 0.9rem; }
.fds-field span { font-weight: 600; }
.fds-field input {
  border: 1.5px solid #e4d9cc;
  border-radius: 10px;
  padding: 12px;
  font: inherit;
  min-height: 44px;
  width: 100%;
}
.fds-field input:focus { outline: 2px solid var(--fds-accent); border-color: var(--fds-accent); }

.fds-field-error { color: #b9433f; font-size: 0.8rem; }

.fds-primary-btn {
  width: 100%;
  min-height: 48px;
  border: none;
  border-radius: 12px;
  background: var(--fds-accent);
  color: #fff;
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
}
.fds-primary-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.fds-primary-btn:not(:disabled):hover { background: var(--fds-accent-dark); }

.fds-secondary-btn {
  border: none;
  border-radius: 8px;
  background: var(--fds-accent-dark);
  color: #fff;
  padding: 8px 12px;
  font-size: 0.85rem;
  cursor: pointer;
}
.fds-secondary-btn:disabled { opacity: 0.6; cursor: not-allowed; }
`;
