/**
 * FOS-Scheduler backend — Google Apps Script Web App.
 *
 * Setup:
 *   1. In your Google Sheet: Extensions > Apps Script.
 *   2. Replace the default Code.gs contents with this file.
 *   3. (Optional) Project Settings (gear icon) > Script Properties > add:
 *        DAILY_CAP  - max sign-ups per day (default 5)
 *        SHEET_NAME - tab name to store sign-ups in (default "Signups")
 *   4. Deploy > New deployment > Web app.
 *        Execute as: Me
 *        Who has access: Anyone
 *   5. Copy the resulting /exec URL into APPS_SCRIPT_URL in
 *      FoodDonationScheduler.jsx (and index.html), commit, push.
 *
 * The sign-ups sheet/tab is created automatically on first request if it
 * doesn't exist yet, with header row: id, date, fullName, email, items, createdAt.
 */

const DEFAULT_CAP = 5;
const DEFAULT_SHEET_NAME = "Signups";
const HEADERS = ["id", "date", "fullName", "email", "items", "createdAt"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    cap: Number(props.getProperty("DAILY_CAP")) || DEFAULT_CAP,
    sheetName: props.getProperty("SHEET_NAME") || DEFAULT_SHEET_NAME,
  };
}

function getSheet_(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  return sheet;
}

function formatDateCell_(value) {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value);
}

function readSignups_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values
    .filter((row) => row[0])
    .map((row) => ({
      id: String(row[0]),
      date: formatDateCell_(row[1]),
      fullName: String(row[2]),
      email: String(row[3]),
      items: String(row[4] || ""),
      createdAt: row[5] instanceof Date ? row[5].toISOString() : String(row[5]),
    }));
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function doGet(e) {
  const config = getConfig_();
  const sheet = getSheet_(config.sheetName);
  return jsonOutput_({ ok: true, cap: config.cap, signups: readSignups_(sheet) });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const config = getConfig_();

    let body;
    try {
      body = JSON.parse((e.postData && e.postData.contents) || "{}");
    } catch (err) {
      return jsonOutput_({ ok: false, error: "Invalid request." });
    }

    const sheet = getSheet_(config.sheetName);
    return body.action === "delete"
      ? handleDelete_(sheet, config, body)
      : handleAdd_(sheet, config, body);
  } finally {
    lock.releaseLock();
  }
}

function handleAdd_(sheet, config, body) {
  const fullName = String(body.fullName || "").trim();
  const email = String(body.email || "").trim();
  const items = String(body.items || "").trim();
  const date = String(body.date || "").trim();

  if (!fullName) {
    return jsonOutput_({ ok: false, error: "Full name is required." });
  }
  if (!EMAIL_RE.test(email)) {
    return jsonOutput_({ ok: false, error: "A valid email address is required." });
  }
  if (!DATE_RE.test(date)) {
    return jsonOutput_({ ok: false, error: "A valid date is required." });
  }

  const sameDay = readSignups_(sheet).filter((s) => s.date === date);

  if (sameDay.length >= config.cap) {
    return jsonOutput_({ ok: false, error: "That day is already full. Please pick another date." });
  }
  if (sameDay.some((s) => s.email.toLowerCase() === email.toLowerCase())) {
    return jsonOutput_({ ok: false, error: "That email is already signed up for this date." });
  }

  const id = Utilities.getUuid();
  sheet.appendRow([id, date, fullName, email, items, new Date()]);
  return jsonOutput_({ ok: true, id: id });
}

function handleDelete_(sheet, config, body) {
  const id = String(body.id || "");

  if (!id) {
    return jsonOutput_({ ok: false, error: "Missing sign-up id." });
  }

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === id) {
        sheet.deleteRow(i + 2);
        return jsonOutput_({ ok: true });
      }
    }
  }
  return jsonOutput_({ ok: false, error: "Sign-up not found." });
}
