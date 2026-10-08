/**
 * Statement Analysis — professional statement underwriting desk.
 */

const CIRC = 2 * Math.PI * 54;
const HISTORY_KEY = "sa_runs_v1";
const NOTES_KEY = "sa_notes_v1";
const UI_SESSION_KEY = "sa_ui_session_v1";
const PAGE_SIZE = 50;
const MAX_HISTORY = 12;
const DB_NAME = "sa_runs";
const DB_STORE = "results";
const APP_NAME = "Statement Analysis";

const state = {
  user: null,
  result: null,
  runId: null,
  view: "login",
  runTab: "upload",
  file: null,
  busy: false,
  error: "",
  stage: 0,
  history: [],
  ledgerQ: "",
  ledgerSide: "all",
  ledgerPage: 0,
  notes: "",
  exportOpen: false,
  ownerName: "",
  periodStart: "",
  periodEnd: "",
  searchQ: "",
  searchOwner: "",
  searchRef: "",
  searchResults: [],
  searchTotal: 0,
  searchTried: false,
  users: [],
  usersLoaded: false,
  userFormError: "",
  userFormOk: "",
};

const STAGES = [
  "Uploading / fetching statement",
  "Extracting ledger lines",
  "Reconciling balances",
  "Running analytics scorecard",
  "Preparing report",
];

const TOC = [
  ["overview", "Overview"],
  ["cashflow", "Cashflow"],
  ["charts", "Charts"],
  ["timing", "When money flows"],
  ["income", "Income"],
  ["loans", "Loans"],
  ["patterns", "Patterns"],
  ["spend", "Spend"],
  ["counterparties", "Counterparties"],
  ["score", "Score factors"],
  ["ledger", "Ledger"],
];

const $app = () => document.getElementById("app");

/* ---------- utils ---------- */

function money(n, currency = "NGN") {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency: currency || "NGN",
      maximumFractionDigits: 2,
    }).format(v);
  } catch {
    return `₦${v.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

function clampPct(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Math.min(100, Math.max(0, Number(n)));
}

function pct(n, digits = 1) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toFixed(digits)}%`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d) {
  if (!d) return "—";
  const t = Date.parse(d);
  if (Number.isNaN(t)) return esc(d);
  return new Date(t).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function fmtDateTime(d) {
  const t = typeof d === "number" ? d : Date.parse(d);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function uid() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function api(path, options = {}) {
  const opts = {
    credentials: "include",
    ...options,
    headers: { ...(options.headers || {}) },
  };
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== "string") {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadUsers(options = {}) {
  const silent = Boolean(options.silent);
  try {
    const data = await api("/api/v1/auth/users");
    state.users = data.users || [];
    state.usersLoaded = true;
    if (!silent) state.error = "";
    if (!silent && state.view === "users") render();
  } catch (err) {
    state.users = [];
    state.usersLoaded = true;
    if (!silent) {
      state.error = err.message || "Could not load users";
      if (state.view === "users") render();
    }
  }
}

function downloadBlob(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function downloadText(filename, text, type = "application/json") {
  downloadBlob(filename, new Blob([text], { type }));
}

/* ---------- IndexedDB history ---------- */

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function loadHistoryMeta() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistoryMeta(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
  state.history = list.slice(0, MAX_HISTORY);
}

async function persistRun(result, sourceLabel) {
  const id = uid();
  const a = result?.analysis || {};
  const st = result?.statement || {};
  const meta = {
    id,
    savedAt: Date.now(),
    sourceLabel: sourceLabel || "Analysis",
    accountName: st.account_name || "Account",
    bankName: st.bank_name || "",
    score: a.score ?? null,
    recommendation: a.decision_support?.recommendation || null,
    periodFrom: a.period?.from || st.statement_period?.from || null,
    periodTo: a.period?.to || st.statement_period?.to || null,
    txCount: result?.summary?.transaction_count ?? result?.transactions?.length ?? 0,
  };
  await idbPut({ id, meta, result });
  const list = [meta, ...loadHistoryMeta().filter((h) => h.id !== id)].slice(0, MAX_HISTORY);
  // prune old full payloads
  const keep = new Set(list.map((h) => h.id));
  for (const old of loadHistoryMeta()) {
    if (!keep.has(old.id)) {
      try {
        await idbDelete(old.id);
      } catch {
        /* ignore */
      }
    }
  }
  saveHistoryMeta(list);
  state.runId = id;
  return id;
}

function loadNotes(runId) {
  if (!runId) return "";
  try {
    const all = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
    return all[runId] || "";
  } catch {
    return "";
  }
}

function saveNotes(runId, text) {
  if (!runId) return;
  try {
    const all = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
    all[runId] = text;
    localStorage.setItem(NOTES_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

function saveUiSession() {
  if (!state.user || state.view === "login") return;
  try {
    sessionStorage.setItem(
      UI_SESSION_KEY,
      JSON.stringify({
        view: state.view,
        runId: state.runId,
        referenceId: state.result?.reference_id || null,
        runTab: state.runTab,
        searchQ: state.searchQ,
        searchOwner: state.searchOwner,
        searchRef: state.searchRef,
        searchResults: state.searchResults,
        searchTotal: state.searchTotal,
        searchTried: state.searchTried,
        ledgerQ: state.ledgerQ,
        ledgerSide: state.ledgerSide,
        ledgerPage: state.ledgerPage,
      }),
    );
  } catch {
    /* quota / private mode */
  }
}

function clearUiSession() {
  try {
    sessionStorage.removeItem(UI_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

async function restoreUiSession() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(UI_SESSION_KEY) || "null");
  } catch {
    saved = null;
  }
  if (!saved?.view) return false;

  state.runTab = saved.runTab === "url" ? "url" : "upload";
  state.searchQ = saved.searchQ || "";
  state.searchOwner = saved.searchOwner || "";
  state.searchRef = saved.searchRef || "";
  state.searchResults = Array.isArray(saved.searchResults) ? saved.searchResults : [];
  state.searchTotal = saved.searchTotal || 0;
  state.searchTried = Boolean(saved.searchTried);
  state.ledgerQ = saved.ledgerQ || "";
  state.ledgerSide = saved.ledgerSide || "all";
  state.ledgerPage = Number(saved.ledgerPage) || 0;

  if (saved.view === "report") {
    if (saved.runId) {
      try {
        const rec = await idbGet(saved.runId);
        if (rec?.result) {
          state.result = rec.result;
          state.runId = saved.runId;
          state.notes = loadNotes(saved.runId);
          state.view = "report";
          return true;
        }
      } catch {
        /* fall through */
      }
    }
    if (saved.referenceId) {
      try {
        const data = await api(`/api/v1/analyses/${encodeURIComponent(saved.referenceId)}`);
        if (data?.result) {
          state.result = data.result;
          state.runId = saved.runId || uid();
          try {
            await idbPut({
              id: state.runId,
              meta: {
                id: state.runId,
                savedAt: Date.now(),
                sourceLabel: "Restored",
                accountName: data.result?.statement?.account_name || "Account",
                bankName: data.result?.statement?.bank_name || "",
                score: data.result?.analysis?.score ?? null,
                recommendation: data.result?.analysis?.decision_support?.recommendation || null,
                periodFrom: null,
                periodTo: null,
                txCount: data.result?.transactions?.length ?? 0,
              },
              result: data.result,
            });
          } catch {
            /* ignore */
          }
          state.notes = loadNotes(state.runId);
          state.view = "report";
          return true;
        }
      } catch {
        /* fall through */
      }
    }
    state.view = "dashboard";
    return true;
  }

  if (saved.view === "search" || saved.view === "users" || saved.view === "dashboard") {
    state.view = saved.view;
    state.result = null;
    return true;
  }
  return false;
}

/* ---------- charts (SVG) ---------- */

function sampleBalances(txs, maxPoints = 80) {
  const withBal = (txs || []).filter((t) => t.balance != null);
  if (!withBal.length) return [];
  const step = Math.max(1, Math.ceil(withBal.length / maxPoints));
  const out = [];
  for (let i = 0; i < withBal.length; i += step) out.push(withBal[i]);
  const last = withBal[withBal.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

function tipAttr(title, detail) {
  return `data-tip-title="${esc(title)}" data-tip-detail="${esc(detail)}" tabindex="0"`;
}

function svgBalanceChart(txs) {
  const pts = sampleBalances(txs);
  if (pts.length < 2) return `<p class="limitations">Not enough balance points to chart.</p>`;
  const w = 640;
  const h = 220;
  const pad = { t: 16, r: 16, b: 28, l: 56 };
  const vals = pts.map((p) => Number(p.balance));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const gradId = `balFill_${Math.random().toString(36).slice(2, 8)}`;
  const coords = pts.map((p, i) => {
    const x = pad.l + (i / (pts.length - 1)) * innerW;
    const y = pad.t + (1 - (Number(p.balance) - min) / span) * innerH;
    return [x, y, p];
  });
  const line = coords.map((c, i) => `${i ? "L" : "M"}${c[0].toFixed(1)},${c[1].toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${(h - pad.b).toFixed(1)} L${coords[0][0].toFixed(1)},${(h - pad.b).toFixed(1)} Z`;
  const zeroY =
    min < 0 && max > 0 ? pad.t + (1 - (0 - min) / span) * innerH : null;
  const dots = coords
    .map(
      ([x, y, p]) =>
        `<circle class="chart-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" ${tipAttr(
          fmtDate(p.transaction_date),
          `Balance ${money(p.balance)}`,
        )} />
         <circle class="chart-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" />`,
    )
    .join("");
  return `
  <div class="chart-wrap chart-interactive" role="img" aria-label="Account balance trend">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#3ecf9a" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#3ecf9a" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${[0, 0.25, 0.5, 0.75, 1]
        .map((t) => {
          const y = pad.t + t * innerH;
          const val = max - t * span;
          return `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="rgba(255,255,255,0.06)"/>
            <text x="${pad.l - 8}" y="${y + 4}" fill="#9fb3ad" font-size="10" text-anchor="end">${esc(Math.round(val).toLocaleString("en-NG"))}</text>`;
        })
        .join("")}
      ${zeroY != null ? `<line x1="${pad.l}" y1="${zeroY}" x2="${w - pad.r}" y2="${zeroY}" stroke="rgba(232,93,76,0.45)" stroke-dasharray="4 4"/>` : ""}
      <path class="chart-area" d="${area}" fill="url(#${gradId})"/>
      <path class="chart-line" d="${line}" fill="none" stroke="#3ecf9a" stroke-width="2.2"/>
      ${dots}
      <text x="${pad.l}" y="${h - 8}" fill="#9fb3ad" font-size="10">${esc(fmtDate(pts[0].transaction_date))}</text>
      <text x="${w - pad.r}" y="${h - 8}" fill="#9fb3ad" font-size="10" text-anchor="end">${esc(fmtDate(pts[pts.length - 1].transaction_date))}</text>
    </svg>
    <div class="chart-tooltip" hidden></div>
  </div>`;
}

function svgMonthlyChart(monthly) {
  if (!monthly?.length) return `<p class="limitations">No monthly data.</p>`;
  const w = 640;
  const h = 220;
  const pad = { t: 16, r: 12, b: 36, l: 12 };
  const max = Math.max(...monthly.map((m) => Math.max(m.credit_total || 0, m.debit_total || 0)), 1);
  const groupW = (w - pad.l - pad.r) / monthly.length;
  const barW = Math.max(6, groupW * 0.28);
  const bars = monthly
    .map((m, i) => {
      const cx = pad.l + i * groupW + groupW / 2;
      const ch = ((m.credit_total || 0) / max) * (h - pad.t - pad.b);
      const dh = ((m.debit_total || 0) / max) * (h - pad.t - pad.b);
      const base = h - pad.b;
      const label = String(m.month);
      return `
        <rect class="chart-bar chart-bar-a" x="${cx - barW - 2}" y="${base - ch}" width="${barW}" height="${Math.max(ch, 0)}" rx="3"
          ${tipAttr(label, `Credits ${money(m.credit_total)}`)} />
        <rect class="chart-bar chart-bar-b" x="${cx + 2}" y="${base - dh}" width="${barW}" height="${Math.max(dh, 0)}" rx="3"
          ${tipAttr(label, `Debits ${money(m.debit_total)}`)} />
        <text x="${cx}" y="${h - 12}" fill="#9fb3ad" font-size="10" text-anchor="middle">${esc(label.slice(5) || label)}</text>`;
    })
    .join("");
  return `
  <div class="chart-wrap chart-interactive" role="img" aria-label="Monthly credits and debits">
    <svg viewBox="0 0 ${w} ${h}">${bars}</svg>
    <div class="chart-legend">
      <span><i style="background:#3ecf9a"></i>Credits</span>
      <span><i style="background:#e8a54b"></i>Debits</span>
    </div>
    <div class="chart-tooltip" hidden></div>
  </div>`;
}

function svgDualBarChart(items, opts = {}) {
  const {
    valueKeyA = "credit_total",
    valueKeyB = "debit_total",
    labelKey = "label",
    aria = "Bar chart",
    labelA = "Credits",
    labelB = "Debits",
  } = opts;
  if (!items?.length) return `<p class="limitations">No data.</p>`;
  const w = 640;
  const h = 220;
  const pad = { t: 16, r: 12, b: 36, l: 12 };
  const max = Math.max(...items.map((m) => Math.max(m[valueKeyA] || 0, m[valueKeyB] || 0)), 1);
  const groupW = (w - pad.l - pad.r) / items.length;
  const barW = Math.max(5, Math.min(18, groupW * 0.28));
  const bars = items
    .map((m, i) => {
      const cx = pad.l + i * groupW + groupW / 2;
      const va = m[valueKeyA] || 0;
      const vb = m[valueKeyB] || 0;
      const ch = (va / max) * (h - pad.t - pad.b);
      const dh = (vb / max) * (h - pad.t - pad.b);
      const base = h - pad.b;
      const label = String(m[labelKey] ?? "");
      const short = label.length > 3 ? label.slice(0, 3) : label;
      return `
        <rect class="chart-bar chart-bar-a" x="${cx - barW - 2}" y="${base - ch}" width="${barW}" height="${Math.max(ch, 0)}" rx="3"
          ${tipAttr(label, `${labelA} ${money(va)}`)} />
        <rect class="chart-bar chart-bar-b" x="${cx + 2}" y="${base - dh}" width="${barW}" height="${Math.max(dh, 0)}" rx="3"
          ${tipAttr(label, `${labelB} ${money(vb)}`)} />
        <text x="${cx}" y="${h - 12}" fill="#9fb3ad" font-size="10" text-anchor="middle">${esc(short)}</text>`;
    })
    .join("");
  return `
  <div class="chart-wrap chart-interactive" role="img" aria-label="${esc(aria)}">
    <svg viewBox="0 0 ${w} ${h}">${bars}</svg>
    <div class="chart-legend">
      <span><i style="background:#3ecf9a"></i>${esc(labelA)}</span>
      <span><i style="background:#e8a54b"></i>${esc(labelB)}</span>
    </div>
    <div class="chart-tooltip" hidden></div>
  </div>`;
}

function hiLoClass(value, max, min, kind) {
  if (!(value > 0)) return "";
  if (value === max) return kind === "deposit" ? "hi-cell" : "hi-cell-alt";
  if (value === min) return "lo-cell";
  return "";
}

function weekMatrixTable(rows, currency, opts = {}) {
  const {
    depositKey = "deposit",
    withdrawKey = "withdrawal",
    depositLabel = "Deposit",
    withdrawLabel = "Withdrawal",
    emptyText = "No weekly activity.",
  } = opts;
  if (!rows?.length) return `<p class="limitations">${esc(emptyText)}</p>`;
  const byMonth = new Map();
  for (const r of rows) {
    const list = byMonth.get(r.month) || [];
    list.push(r);
    byMonth.set(r.month, list);
  }
  const months = [...byMonth.keys()].sort().filter((month) => {
    const cells = byMonth.get(month) || [];
    return cells.some(
      (c) => Number(c[depositKey] || 0) > 0 || Number(c[withdrawKey] || 0) > 0,
    );
  });
  if (!months.length) return `<p class="limitations">${esc(emptyText)}</p>`;
  const body = months
    .map((month) => {
      const cells = byMonth.get(month) || [];
      const byWeek = new Map(cells.map((c) => [c.week, c]));
      const deps = [1, 2, 3, 4].map((w) => Number(byWeek.get(w)?.[depositKey] || 0));
      const wds = [1, 2, 3, 4].map((w) => Number(byWeek.get(w)?.[withdrawKey] || 0));
      const maxD = Math.max(...deps);
      const minDPos = deps.filter((v) => v > 0);
      const minD = minDPos.length ? Math.min(...minDPos) : 0;
      const maxW = Math.max(...wds);
      const minWPos = wds.filter((v) => v > 0);
      const minW = minWPos.length ? Math.min(...minWPos) : 0;
      const tds = [1, 2, 3, 4]
        .map((w) => {
          const d = deps[w - 1];
          const wd = wds[w - 1];
          return `<td class="num ${hiLoClass(d, maxD, minD, "deposit")}">${money(d, currency)}</td>
            <td class="num ${hiLoClass(wd, maxW, minW, "withdraw")}">${money(wd, currency)}</td>`;
        })
        .join("");
      return `<tr><td>${esc(month)}</td>${tds}</tr>`;
    })
    .join("");
  return `
  <div class="tx-scroll week-matrix-wrap">
    <table class="tx-table week-matrix">
      <thead>
        <tr>
          <th rowspan="2">Month</th>
          <th colspan="2">Week 1</th>
          <th colspan="2">Week 2</th>
          <th colspan="2">Week 3</th>
          <th colspan="2">Week 4/5</th>
        </tr>
        <tr>
          <th class="num">${esc(depositLabel)}</th><th class="num">${esc(withdrawLabel)}</th>
          <th class="num">${esc(depositLabel)}</th><th class="num">${esc(withdrawLabel)}</th>
          <th class="num">${esc(depositLabel)}</th><th class="num">${esc(withdrawLabel)}</th>
          <th class="num">${esc(depositLabel)}</th><th class="num">${esc(withdrawLabel)}</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <p class="field-hint week-legend"><span class="hi-swatch"></span> Max · <span class="lo-swatch"></span> Min (per month, non-zero)</p>`;
}

function svgDonut(categories, currency) {
  // Spend mix = debit volume only (credits like betting winnings must not inflate "spend").
  const items = (categories || [])
    .map((c) => ({
      name: c.category,
      value: c.debit_total || 0,
      credit: c.credit_total || 0,
    }))
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 7);
  if (!items.length) return `<p class="limitations">No category volume.</p>`;
  const total = items.reduce((s, c) => s + c.value, 0) || 1;
  const colors = ["#3ecf9a", "#e8a54b", "#6ec6ff", "#c792ea", "#ffb0a6", "#f3ebe0", "#7f9c96"];
  const r = 70;
  const cx = 90;
  const cy = 90;
  let angle = -Math.PI / 2;
  const arcs = items
    .map((item, i) => {
      const slice = (item.value / total) * Math.PI * 2;
      const a2 = angle + slice;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(a2);
      const y2 = cy + r * Math.sin(a2);
      const large = slice > Math.PI ? 1 : 0;
      const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
      angle = a2;
      const share = ((item.value / total) * 100).toFixed(1);
      return `<path class="chart-slice" d="${d}" fill="${colors[i % colors.length]}" opacity="0.92"
        ${tipAttr(item.name.replace(/_/g, " "), `${money(item.value, currency)} · ${share}%`)} />`;
    })
    .join("");
  return `
  <div class="chart-wrap chart-interactive" role="img" aria-label="Category composition">
    <svg viewBox="0 0 280 180">
      ${arcs}
      <circle cx="${cx}" cy="${cy}" r="42" fill="#0d242c"/>
      <text x="${cx}" y="${cy - 2}" fill="#eef5f1" font-size="13" text-anchor="middle" font-family="Syne,sans-serif">Mix</text>
      <text x="${cx}" y="${cy + 14}" fill="#9fb3ad" font-size="10" text-anchor="middle">${items.length} cats</text>
    </svg>
    <div class="chart-legend">
      ${items
        .map(
          (item, i) =>
            `<span><i style="background:${colors[i % colors.length]}"></i>${esc(item.name)} · ${money(item.value, currency)}</span>`,
        )
        .join("")}
    </div>
    <div class="chart-tooltip" hidden></div>
  </div>`;
}

function bindInteractiveCharts() {
  document.querySelectorAll(".chart-interactive").forEach((wrap) => {
    const tip = wrap.querySelector(".chart-tooltip");
    if (!tip) return;
    const hide = () => {
      tip.hidden = true;
      wrap.querySelectorAll(".is-active").forEach((el) => el.classList.remove("is-active"));
    };
    const show = (el, clientX, clientY) => {
      const title = el.getAttribute("data-tip-title") || "";
      const detail = el.getAttribute("data-tip-detail") || "";
      tip.innerHTML = `<strong>${esc(title)}</strong>${detail ? `<span>${esc(detail)}</span>` : ""}`;
      tip.hidden = false;
      wrap.querySelectorAll(".is-active").forEach((n) => n.classList.remove("is-active"));
      el.classList.add("is-active");
      const rect = wrap.getBoundingClientRect();
      const x = Math.min(Math.max(12, clientX - rect.left + 12), rect.width - 12);
      const y = Math.min(Math.max(12, clientY - rect.top - 8), rect.height - 12);
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    };
    wrap.querySelectorAll("[data-tip-title]").forEach((el) => {
      el.addEventListener("pointerenter", (e) => show(el, e.clientX, e.clientY));
      el.addEventListener("pointermove", (e) => show(el, e.clientX, e.clientY));
      el.addEventListener("pointerleave", hide);
      el.addEventListener("focus", () => {
        const box = el.getBoundingClientRect();
        const wrapBox = wrap.getBoundingClientRect();
        show(el, box.left + box.width / 2, box.top);
        tip.style.left = `${box.left - wrapBox.left + box.width / 2}px`;
        tip.style.top = `${Math.max(12, box.top - wrapBox.top - 8)}px`;
      });
      el.addEventListener("blur", hide);
    });
  });
}

/* ---------- render helpers ---------- */

function kvRows(rows) {
  return `
  <table class="kv-table"><tbody>
    ${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("")}
  </tbody></table>`;
}

function effectiveFlags(analysis) {
  const flags = { ...(analysis?.flags || {}) };
  const gambleCat = (analysis?.categories || []).find((c) => c.category === "gambling");
  const gin = Number(analysis?.spend?.total_gambling_inflow ?? gambleCat?.credit_total ?? 0);
  const gout = Number(analysis?.spend?.total_gambling ?? gambleCat?.debit_total ?? 0);
  if (gin > 0 || gout > 0) {
    flags.is_gambler = true;
    if (gin >= 500_000 || gin + gout >= 500_000) flags.regular_gambler = true;
  }
  return flags;
}

function flagPills(flags) {
  if (!flags) return "";
  const items = [
    ["has_salary", "Salary", "pos"],
    ["has_recurring_income", "Recurring income", "pos"],
    ["is_borrower", "Borrower", "warn"],
    ["frequent_borrower", "Frequent borrower", "neg"],
    ["is_gambler", "Gambler", "neg"],
    ["regular_gambler", "Regular gambler", "neg"],
    ["is_overdraft", "Overdraft", "neg"],
    ["is_clubbing", "Entertainment", "warn"],
    ["is_religion", "Religion", ""],
    ["is_statement_recent", "Recent statement", "pos"],
  ];
  return items
    .map(([k, label, tone]) => {
      const on = !!flags[k];
      const cls = on ? tone || "pos" : "";
      return `<span class="pill ${cls}">${esc(label)}: ${on ? "Yes" : "No"}</span>`;
    })
    .join("");
}

function progressHtml() {
  if (!state.busy) return "";
  return `
  <div class="progress-stages" aria-live="polite">
    ${STAGES.map(
      (label, i) => `
      <div class="stage ${i < state.stage ? "done" : ""} ${i === state.stage ? "active" : ""}">
        <span class="dot" aria-hidden="true"></span>
        <span>${esc(label)}</span>
      </div>`,
    ).join("")}
  </div>`;
}

function historyHtml() {
  if (!state.history.length) {
    return `<p class="limitations" style="margin:0">No saved runs yet. Completed analyses appear here.</p>`;
  }
  return `
  <div class="history-list">
    ${state.history
      .map(
        (h) => `
      <button type="button" class="history-item" data-run="${esc(h.id)}">
        <div>
          <div class="t">${esc(h.accountName)}</div>
          <div class="s">${esc(h.bankName || "Bank")} · ${fmtDateTime(h.savedAt)} · ${esc(String(h.txCount))} tx · ${esc(h.sourceLabel || "")}</div>
        </div>
        <div class="score">${h.score != null ? esc(String(h.score)) : "—"}</div>
      </button>`,
      )
      .join("")}
  </div>`;
}

function analysisWindowBounds() {
  const data = state.result || {};
  const a = data.analysis || {};
  const from =
    data.analysis_period?.from || a.request?.period_start || null;
  const to = data.analysis_period?.to || a.request?.period_end || null;
  return { from, to };
}

function filteredLedger() {
  const txs = state.result?.transactions || [];
  const q = state.ledgerQ.trim().toLowerCase();
  const { from, to } = analysisWindowBounds();
  return txs.filter((t) => {
    if (state.ledgerSide === "debit" && t.debit == null) return false;
    if (state.ledgerSide === "credit" && t.credit == null) return false;
    if (from || to) {
      const d = (t.transaction_date || t.value_date || "").slice(0, 10);
      if (!d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
    }
    if (!q) return true;
    const hay = `${t.description || ""} ${t.reference || ""} ${t.transaction_type || ""}`.toLowerCase();
    return hay.includes(q);
  });
}

function ledgerRowsHtml(currency) {
  const filtered = filteredLedger();
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (state.ledgerPage >= pages) state.ledgerPage = pages - 1;
  if (state.ledgerPage < 0) state.ledgerPage = 0;
  const start = state.ledgerPage * PAGE_SIZE;
  const slice = filtered.slice(start, start + PAGE_SIZE);
  return {
    html: slice
      .map(
        (t) => `
      <tr>
        <td>${fmtDate(t.transaction_date || t.value_date)}</td>
        <td>${esc(t.description || "—")}${t.transaction_type ? `<div style="color:var(--muted);font-size:.75rem;margin-top:2px">${esc(t.transaction_type)}</div>` : ""}</td>
        <td class="amt-d">${t.debit != null ? money(t.debit, currency) : ""}</td>
        <td class="amt-c">${t.credit != null ? money(t.credit, currency) : ""}</td>
        <td>${t.balance != null ? money(t.balance, currency) : "—"}</td>
      </tr>`,
      )
      .join(""),
    filtered,
    pages,
    start,
  };
}

/* ---------- screens ---------- */

function renderLogin() {
  return `
  <div class="login-shell">
    <div class="login-stage">
      <div class="brand-mark">
        <div class="glyph" aria-hidden="true"></div>
        <strong>${APP_NAME}</strong>
      </div>
      <div class="login-panel">
        <h1>See the story in every statement.</h1>
        <p class="lede">Sign in to extract, reconcile, and underwrite bank statements with a clear scorecard.</p>
        ${state.error ? `<div class="form-error" role="alert">${esc(state.error)}</div>` : ""}
        <form id="login-form">
          <div class="field">
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username" required value="demo@statement.local" />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required value="demo1234" />
          </div>
          <button class="btn btn-primary block" type="submit" ${state.busy ? "disabled" : ""}>
            ${state.busy ? "Signing in…" : "Continue"}
          </button>
        </form>
        <p class="hint">Demo access: <code>demo@statement.local</code> / <code>demo1234</code></p>
      </div>
    </div>
  </div>`;
}

function optionalAnalysisFieldsHtml(prefix = "") {
  return `
  <div class="optional-grid">
    <div class="field">
      <label for="${prefix}owner-name">Statement owner name <span class="opt">optional</span></label>
      <input id="${prefix}owner-name" type="text" maxlength="200" placeholder="e.g. Ada Okonkwo" value="${esc(state.ownerName)}" />
    </div>
    <div class="field">
      <label for="${prefix}period-start">Analyse from <span class="opt">optional</span></label>
      <input id="${prefix}period-start" type="date" value="${esc(state.periodStart)}" />
    </div>
    <div class="field">
      <label for="${prefix}period-end">Analyse to <span class="opt">optional</span></label>
      <input id="${prefix}period-end" type="date" value="${esc(state.periodEnd)}" />
    </div>
  </div>
  <p class="field-hint">Leave dates empty to analyse the full statement. A reference ID is assigned after each successful run.</p>`;
}

function shellNav(active) {
  const u = state.user;
  return `
  <header class="topbar">
    <div class="brand-mark" style="margin:0">
      <div class="glyph" aria-hidden="true"></div>
      <strong>${APP_NAME}</strong>
    </div>
    <nav class="main-nav" aria-label="Primary">
      <button type="button" class="nav-link ${active === "dashboard" ? "active" : ""}" data-nav="dashboard">Analyse</button>
      <button type="button" class="nav-link ${active === "search" ? "active" : ""}" data-nav="search">Search</button>
      <button type="button" class="nav-link ${active === "users" ? "active" : ""}" data-nav="users">Users</button>
    </nav>
    <div class="user">
      <div class="avatar" aria-hidden="true">${esc(initials(u?.name))}</div>
      <span>${esc(u?.name || u?.email)}</span>
      <button class="btn btn-ghost btn-sm" type="button" id="logout-btn">Sign out</button>
    </div>
  </header>`;
}

function renderUsers() {
  const rows = state.users.length
    ? state.users
        .map(
          (u) => `
      <tr>
        <td><strong>${esc(u.name)}</strong></td>
        <td>${esc(u.email)}</td>
        <td class="muted">${esc(fmtDateTime(u.createdAt || u.created_at))}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="muted">${state.usersLoaded ? "No users yet." : "Loading…"}</td></tr>`;

  return `
  <div class="shell fade-in">
    ${shellNav("users")}

    <section class="hero-dash">
      <div class="eyebrow">Access</div>
      <h1>Users</h1>
      <p>Add colleagues who can sign in to run analyses and search the archive.</p>
    </section>

    <div class="users-layout">
      <div class="surface">
        <h2>Add user</h2>
        <p class="sub">They can sign in immediately with the password you set.</p>
        ${state.userFormError ? `<div class="form-error" role="alert">${esc(state.userFormError)}</div>` : ""}
        ${state.userFormOk ? `<div class="form-ok" role="status">${esc(state.userFormOk)}</div>` : ""}
        <form id="add-user-form" class="user-form">
          <div class="field">
            <label for="new-user-name">Name</label>
            <input id="new-user-name" name="name" type="text" maxlength="120" placeholder="e.g. Ada Okonkwo" />
          </div>
          <div class="field">
            <label for="new-user-email">Email</label>
            <input id="new-user-email" name="email" type="email" required autocomplete="off" placeholder="ada@company.com" />
          </div>
          <div class="field">
            <label for="new-user-password">Password</label>
            <input id="new-user-password" name="password" type="password" required minlength="4" autocomplete="new-password" placeholder="Min. 4 characters" />
          </div>
          <button class="btn btn-primary" type="submit" ${state.busy ? "disabled" : ""}>
            ${state.busy ? "Adding…" : "Add user"}
          </button>
        </form>
      </div>

      <div class="surface">
        <h2>Team</h2>
        <p class="sub">${state.users.length} user${state.users.length === 1 ? "" : "s"}</p>
        ${state.error ? `<div class="form-error" role="alert">${esc(state.error)}</div>` : ""}
        <div class="table-wrap">
          <table class="users-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Added</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  </div>`;
}

function renderDashboard() {
  return `
  <div class="shell fade-in">
    ${shellNav("dashboard")}

    <section class="hero-dash">
      <div class="eyebrow">Statement desk</div>
      <h1>Run analysis</h1>
      <p>Upload a PDF or paste a secure link. Optionally set the owner name and an analysis date window. Every run gets a searchable reference ID.</p>
    </section>

    <div class="run-panel">
      <div class="surface">
        <h2>New analysis</h2>
        <p class="sub">PDF or CSV statements · Access-dense layouts supported</p>
        <div class="tabs" role="tablist">
          <button type="button" class="tab ${state.runTab === "upload" ? "active" : ""}" data-tab="upload" role="tab" aria-selected="${state.runTab === "upload"}">Upload file</button>
          <button type="button" class="tab ${state.runTab === "url" ? "active" : ""}" data-tab="url" role="tab" aria-selected="${state.runTab === "url"}">Use link</button>
        </div>
        ${state.error ? `<div class="form-error" role="alert">${esc(state.error)}</div>` : ""}
        ${
          state.runTab === "upload"
            ? `
          <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Choose statement file">
            <strong>Drop PDF or CSV here</strong>
            <span>or click to browse</span>
            <input type="file" id="file-input" accept=".pdf,.csv,application/pdf,text/csv" hidden />
          </div>
          ${
            state.file
              ? `<div class="file-chip"><span>${esc(state.file.name)}</span><span>· ${(state.file.size / 1024 / 1024).toFixed(2)} MB</span></div>`
              : ""
          }
          <div class="field" style="margin-top:16px">
            <label for="pdf-password">PDF password <span class="opt">optional</span></label>
            <input id="pdf-password" type="password" autocomplete="off" placeholder="If the statement is locked" />
          </div>
          ${optionalAnalysisFieldsHtml("up-")}
          <button class="btn btn-primary block" type="button" id="run-upload" ${state.busy || !state.file ? "disabled" : ""}>
            ${state.busy ? "Working…" : "Run analysis"}
          </button>
        `
            : `
          <form id="url-form">
            <div class="field">
              <label for="stmt-url">Statement URL</label>
              <input id="stmt-url" type="url" required placeholder="https://…" />
            </div>
            <div class="field">
              <label for="url-password">PDF password <span class="opt">optional</span></label>
              <input id="url-password" type="password" autocomplete="off" />
            </div>
            ${optionalAnalysisFieldsHtml("url-")}
            <button class="btn btn-primary block" type="submit" ${state.busy ? "disabled" : ""}>
              ${state.busy ? "Working…" : "Run analysis"}
            </button>
          </form>
        `
        }
        <div class="status-line ${state.busy ? "busy" : ""}">${state.busy ? "Large statements can take a minute…" : ""}</div>
        ${progressHtml()}
      </div>

      <aside class="side-notes">
        <div class="note">
          <strong>Searchable archive</strong>
          <p>Find past runs by owner name or reference ID (e.g. <code>APT-A1B2C3D4</code>) on the Search page.</p>
        </div>
        <div class="note">
          <strong>Local history</strong>
          <p style="margin-bottom:10px">Also cached on this device for quick reopen.</p>
          ${historyHtml()}
        </div>
        <button class="btn btn-ghost" type="button" id="sample-report-btn" style="width:100%">Preview sample report</button>
      </aside>
    </div>
  </div>`;
}

function renderSearch() {
  return `
  <div class="shell fade-in">
    ${shellNav("search")}

    <section class="hero-dash">
      <div class="eyebrow">Archive</div>
      <h1>Search analyses</h1>
      <p>Look up completed statement analyses by owner name or the reference ID assigned when the PDF was analysed.</p>
    </section>

    <div class="surface search-panel">
      <form id="search-form" class="search-form">
        <div class="field grow">
          <label for="search-q">Search</label>
          <input id="search-q" type="search" placeholder="Name, bank, filename…" value="${esc(state.searchQ)}" />
        </div>
        <div class="field">
          <label for="search-owner">Owner name</label>
          <input id="search-owner" type="text" placeholder="Statement owner" value="${esc(state.searchOwner)}" />
        </div>
        <div class="field">
          <label for="search-ref">Reference ID</label>
          <input id="search-ref" type="text" placeholder="APT-…" value="${esc(state.searchRef)}" />
        </div>
        <button class="btn btn-primary" type="submit" ${state.busy ? "disabled" : ""}>Search</button>
      </form>
      ${state.error ? `<div class="form-error" role="alert">${esc(state.error)}</div>` : ""}
      <div class="search-meta">
        ${
          state.searchTried
            ? `${state.searchTotal} result${state.searchTotal === 1 ? "" : "s"}`
            : "Enter a name or reference ID to begin"
        }
      </div>
      <div class="search-results">
        ${
          state.searchTried && !state.searchResults.length
            ? `<p class="limitations">No analyses matched. Run an analysis first, or try the sample report (reference <code>APT-SAMPLE01</code>).</p>`
            : state.searchResults
                .map(
                  (r) => `
            <button type="button" class="search-card" data-ref="${esc(r.reference_id)}">
              <div class="search-card-top">
                <strong>${esc(r.owner_name || r.account_name || "Unknown owner")}</strong>
                <code class="ref-chip">${esc(r.reference_id)}</code>
              </div>
              <div class="search-card-meta">
                ${esc(r.bank_name || "Bank")}
                ${r.account_number ? ` · ${esc(r.account_number)}` : ""}
                · ${fmtDate(r.period_from)} → ${fmtDate(r.period_to)}
                ${r.analysis_from || r.analysis_to ? ` · window ${fmtDate(r.analysis_from)} → ${fmtDate(r.analysis_to)}` : ""}
                · ${esc(String(r.tx_count))} tx
                · score ${r.score != null ? esc(String(r.score)) : "—"}
              </div>
              <div class="search-card-meta">${fmtDateTime(r.created_at)} · ${esc(r.source || "")}</div>
            </button>`,
                )
                .join("")
        }
      </div>
    </div>
  </div>`;
}

function renderReport() {
  const data = state.result;
  const a = data?.analysis || {};
  const st = data?.statement || {};
  const currency = st.currency || data?.summary?.currency || "NGN";
  const score = a.score == null || Number.isNaN(Number(a.score)) ? null : Number(a.score);
  const scoreRing = score == null ? 0 : Math.min(100, Math.max(0, score));
  const offset = CIRC - (scoreRing / 100) * CIRC;
  const rec = a.decision_support?.recommendation || "review";
  const activity = Math.max(
    clampPct(a.activity?.monthly_deposit_activity_pct) ?? 0,
    clampPct(a.activity?.monthly_withdrawal_activity_pct) ?? 0,
  );
  const stmtFrom = st.statement_period?.from;
  const stmtTo = st.statement_period?.to;
  const analysedFrom = data.analysis_period?.from || a.request?.period_start || null;
  const analysedTo = data.analysis_period?.to || a.request?.period_end || null;
  const deepestOd =
    a.cashflow?.highest_overdraft == null
      ? null
      : Math.abs(Number(a.cashflow.highest_overdraft));
  const flags = effectiveFlags(a);
  const topClusters = (a.income?.clusters || []).slice(0, 6);
  const loanEvents = [...(a.loans?.events || [])].sort((x, y) =>
    String(x.date || "").localeCompare(String(y.date || "")),
  );
  const loanTableDisbursed = loanEvents
    .filter((e) => e.side === "disbursement")
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const loanTableRepaid = loanEvents
    .filter((e) => e.side === "repayment")
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
  const sweepRatio = a.behavior?.average_deposit_sweep;
  const sweepPct =
    sweepRatio == null || Number.isNaN(Number(sweepRatio))
      ? null
      : Math.round(Number(sweepRatio) * 1000) / 10; // e.g. 1.03 → 103.0
  const categories = (a.categories || [])
    .filter((c) => (c.debit_total || 0) + (c.credit_total || 0) > 0)
    .sort((x, y) => y.debit_total + y.credit_total - (x.debit_total + x.credit_total));
  const bands = Object.entries(a.deposit_size_bands || {});
  const risks = a.risks || [];
  const ledger = ledgerRowsHtml(currency);
  const spike = a.behavior?.spike || {};

  return `
  <div class="shell fade-in">
    <header class="topbar no-print">
      <div class="brand-mark" style="margin:0">
        <div class="glyph" aria-hidden="true"></div>
        <strong>${APP_NAME}</strong>
      </div>
      <div class="user report-actions">
        <button class="btn btn-soft btn-sm" type="button" id="back-dash">New analysis</button>
        <button class="btn btn-ghost btn-sm" type="button" data-nav="search">Search</button>
        <button class="btn btn-ghost btn-sm" type="button" data-nav="users">Users</button>
        <div class="menu ${state.exportOpen ? "open" : ""}" id="export-menu">
          <button class="btn btn-ghost btn-sm" type="button" id="export-toggle" aria-haspopup="true" aria-expanded="${state.exportOpen}">Export</button>
          <div class="menu-panel" role="menu">
            <button type="button" data-export="print">Print / PDF</button>
            <button type="button" data-export="json">Download JSON</button>
            <button type="button" data-export="csv">Download CSV ledger</button>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" id="logout-btn">Sign out</button>
      </div>
    </header>

    <div class="report-layout">
      <nav class="report-toc" aria-label="Report sections">
        <div class="toc-title">On this report</div>
        ${TOC.map(([id, label]) => `<a href="#${id}" data-toc="${id}">${esc(label)}</a>`).join("")}
      </nav>

      <div class="report-main">
        <div class="report-top" id="overview">
          <div>
            <div class="eyebrow">Analysis report</div>
            <h1>${esc(data.owner_name || st.account_name || "Account")}</h1>
            <p class="meta">
              ${data.reference_id ? `<code class="ref-chip">${esc(data.reference_id)}</code> · ` : ""}
              ${esc(st.bank_name || "Bank")} · ${esc(st.account_number || "••••")}
              ${st.account_type ? ` · ${esc(st.account_type)}` : ""} ·
              statement ${fmtDate(stmtFrom)} → ${fmtDate(stmtTo)}
              ${a.period?.months ? ` · ${a.period.months} months analysed` : ""} ·
              ${esc(String(data.summary?.transaction_count ?? 0))} transactions
              ${
                analysedFrom || analysedTo
                  ? ` · window ${fmtDate(analysedFrom)} → ${fmtDate(analysedTo)}`
                  : ""
              }
            </p>
          </div>
          <div>
            <span class="decision ${esc(rec)}">${esc(String(rec).replace(/_/g, " "))}</span>
          </div>
        </div>

        <div class="surface score-hero report-section">
          <div class="score-ring" aria-label="Analytics score ${score == null ? "unavailable" : score}">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="track" cx="60" cy="60" r="54"></circle>
              <circle class="value" cx="60" cy="60" r="54" style="stroke-dashoffset:${offset}"></circle>
            </svg>
            <div class="label">
              <strong>${score == null ? "—" : esc(String(score))}</strong>
              <span>${esc(a.score_band || "score")}</span>
            </div>
          </div>
          <div>
            <h2 style="font-family:var(--font-display);margin:0 0 8px;letter-spacing:-.03em;font-size:1.35rem">Decision support</h2>
            <p style="margin:0 0 14px;color:var(--muted);line-height:1.5">${esc(a.decision_support?.summary || "No summary.")}</p>
            <div class="pill-row" style="margin-bottom:14px">
              ${(a.decision_support?.reason_codes || []).map((c) => `<span class="pill neg">${esc(c)}</span>`).join("") || '<span class="pill">No adverse codes</span>'}
            </div>
            <div class="pill-row">${flagPills(flags)}</div>
            ${
              flags.is_gambler
                ? `<p class="gambler-callout">Tagged as gambler — betting inflows ${money(
                    a.spend?.total_gambling_inflow ??
                      (a.categories || []).find((c) => c.category === "gambling")?.credit_total ??
                      0,
                    currency,
                  )}${
                    a.spend?.total_gambling
                      ? ` · stakes ${money(a.spend.total_gambling, currency)}`
                      : ""
                  }${flags.regular_gambler ? " · regular pattern" : ""}.</p>`
                : ""
            }
            <p style="margin:14px 0 0;color:var(--muted);font-size:.86rem">
              Reconciliation: <strong style="color:var(--text)">${esc(data.validation?.reconciliation_status || "—")}</strong>
              ${data.validation?.reconciled ? " · matched" : ""}
              · Extract confidence ${pct((data.quality?.confidence ?? 0) * 100, 0)}
              · Name check ${esc(String(a.name_check?.score ?? "—"))}/100
            </p>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi"><div class="k">Total deposit</div><div class="v">${money(a.totals?.total_deposit, currency)}</div></div>
          <div class="kpi"><div class="k">Total withdrawal</div><div class="v">${money(a.totals?.total_withdrawal, currency)}</div></div>
          <div class="kpi"><div class="k">Avg monthly deposit</div><div class="v">${money(a.totals?.average_monthly_deposit, currency)}</div></div>
          <div class="kpi"><div class="k">Account activity</div><div class="v">${pct(activity, 0)}</div></div>
        </div>

        <div class="grid-2 report-section" id="cashflow">
          <div class="surface">
            <div class="section-head"><h2>Cashflow highlights</h2><span>Deposit vs withdrawal</span></div>
            ${kvRows([
              ["Transaction total", `${money(a.totals?.total_deposit, currency)} / ${money(a.totals?.total_withdrawal, currency)}`],
              ["Monthly average", `${money(a.totals?.average_monthly_deposit, currency)} / ${money(a.totals?.average_monthly_withdrawal, currency)}`],
              ["Daily average", `${money(a.totals?.average_daily_deposit, currency)} / ${money(a.totals?.average_daily_withdrawal, currency)}`],
              ["Withdrawal / deposit", pct(a.totals?.withdrawal_to_deposit_ratio)],
              [
                "Gambling activity / deposit",
                (() => {
                  const gin =
                    a.spend?.total_gambling_inflow ??
                    (a.categories || []).find((c) => c.category === "gambling")?.credit_total ??
                    0;
                  const gout = a.spend?.total_gambling ?? 0;
                  const ratio = a.totals?.gamble_to_deposit_ratio;
                  const ratioText = pct(ratio);
                  if ((gin || 0) + (gout || 0) <= 0) return ratioText;
                  return `${ratioText} · ${money((gin || 0) + (gout || 0), currency)} activity`;
                })(),
              ],
              ["Credit turnover", money(a.totals?.credit_turnover, currency)],
              ["Avg daily balance", money(a.totals?.average_daily_balance, currency)],
              ["Opening → closing", `${money(a.totals?.opening_balance ?? st.opening_balance, currency)} → ${money(a.totals?.closing_balance ?? st.closing_balance, currency)}`],
              ["Net deposit (ex-reversals)", money(a.totals?.net_deposit, currency)],
              ["Reversal credits", `${money(a.totals?.reversal_credit_total, currency)} (${a.totals?.reversal_count ?? 0})`],
            ])}
          </div>
          <div class="surface">
            <div class="section-head"><h2>Activity & balances</h2><span>Usage intensity</span></div>
            ${kvRows([
              ["Deposit days", String(a.activity?.deposit_days ?? "—")],
              ["Withdrawal days", String(a.activity?.withdrawal_days ?? "—")],
              ["Transaction days", String(a.activity?.transaction_days ?? "—")],
              ["Monthly deposit activity", pct(clampPct(a.activity?.monthly_deposit_activity_pct))],
              ["Monthly withdrawal activity", pct(clampPct(a.activity?.monthly_withdrawal_activity_pct))],
              ["Lowest balance", money(a.cashflow?.lowest_balance, currency)],
              ["Highest balance", money(a.cashflow?.highest_balance, currency)],
              ["Zero-balance days", String(a.cashflow?.zero_balance_days ?? 0)],
              ["Overdraft days", String(a.cashflow?.overdraft_days ?? 0)],
              ["Deepest overdraft", money(deepestOd, currency)],
              ["Avg monthly net", money(a.cashflow?.average_monthly_net, currency)],
            ])}
          </div>
        </div>

        <div class="grid-2 report-section" id="charts">
          <div class="surface">
            <div class="section-head"><h2>Balance trend</h2><span>Sampled across the ledger</span></div>
            ${svgBalanceChart(data.transactions)}
          </div>
          <div class="surface">
            <div class="section-head"><h2>Monthly flow</h2><span>Credits vs debits</span></div>
            ${svgMonthlyChart(a.cashflow?.monthly)}
          </div>
        </div>

        <div class="report-section" id="timing">
          <div class="surface">
            <div class="section-head"><h2>When money flows in</h2><span>Day &amp; week-of-month timing</span></div>
            ${kvRows([
              ["Peak inflow weekday", a.timing?.peak_inflow_weekday || "—"],
              [
                "Peak week of month",
                a.timing?.peak_inflow_week_of_month != null
                  ? `Week ${a.timing.peak_inflow_week_of_month}`
                  : "—",
              ],
              [
                "Peak day of month",
                a.timing?.peak_inflow_day_of_month != null
                  ? `Day ${a.timing.peak_inflow_day_of_month}`
                  : "—",
              ],
            ])}
            <div class="grid-2" style="margin-top:14px">
              <div>
                <div class="section-head"><h2 style="font-size:1rem">By weekday</h2><span>Credits vs debits</span></div>
                ${svgDualBarChart(a.timing?.by_weekday || [], {
                  labelKey: "label",
                  aria: "Inflows by weekday",
                })}
              </div>
              <div>
                <div class="section-head"><h2 style="font-size:1rem">By week of month</h2><span>W1–W4 totals</span></div>
                ${svgDualBarChart(
                  (a.timing?.week_of_month_totals || []).map((w) => ({
                    label: `W${w.week}`,
                    credit_total: w.deposit,
                    debit_total: w.withdrawal,
                  })),
                  { aria: "Inflows by week of month", labelA: "Deposits", labelB: "Withdrawals" },
                )}
              </div>
            </div>
            <div style="margin-top:14px">
              <div class="section-head"><h2 style="font-size:1rem">By day of month</h2><span>Payday pattern</span></div>
              ${svgDualBarChart(
                (a.timing?.by_day_of_month || []).map((d) => ({
                  label: String(d.day),
                  credit_total: d.credit_total,
                  debit_total: d.debit_total,
                })),
                { aria: "Inflows by day of month" },
              )}
            </div>
            <div style="margin-top:18px">
              <div class="section-head"><h2 style="font-size:1rem">Weekly transactions</h2><span>Deposit / withdrawal by week</span></div>
              ${weekMatrixTable(a.timing?.week_of_month || [], currency, {
                depositKey: "deposit",
                withdrawKey: "withdrawal",
                depositLabel: "Deposit",
                withdrawLabel: "Withdrawal",
              })}
            </div>
            <div style="margin-top:18px">
              <div class="section-head"><h2 style="font-size:1rem">Salary distribution</h2><span>Salary / benefit by week</span></div>
              ${weekMatrixTable(a.timing?.week_of_month || [], currency, {
                depositKey: "salary",
                withdrawKey: "benefit",
                depositLabel: "Salary",
                withdrawLabel: "Benefit",
                emptyText: "No salary or benefit recorded by week.",
              })}
            </div>
          </div>
        </div>

        <div class="grid-2 report-section" id="income">
          <div class="surface">
            <div class="section-head"><h2>Income & salary</h2><span>Clusters & confidence</span></div>
            ${kvRows([
              ["Confirmed salary total", money(a.income?.total_salary, currency)],
              ["Average salary", money(a.income?.average_salary, currency)],
              ["Salary count", String(a.income?.salary_count ?? 0)],
              ["Suspected recurring", money(a.income?.suspected_recurring_total, currency)],
              ["Suspected salary total", money(a.income?.suspected_salary_total, currency)],
              ["Benefit total", money(a.income?.benefit_total, currency)],
              ["Other income", money(a.income?.other_income, currency)],
              ["Stable income months", String(a.income?.stable_income_months ?? 0)],
              ["Salary confidence", pct((a.income?.confirmed_salary_confidence ?? 0) * 100, 0)],
            ])}
            ${
              topClusters.length
                ? `<div style="margin-top:14px"><div class="section-head"><h2 style="font-size:1rem">Top income clusters</h2></div>
                ${kvRows(
                  topClusters.map((c) => [
                    `${(c.label || "cluster").replace(/_/g, " ")} · ${money(c.amount, currency)}`,
                    `${c.count}× · day ${c.day_of_month_mode ?? "—"} · conf ${pct((c.confidence || 0) * 100, 0)}`,
                  ]),
                )}</div>`
                : ""
            }
          </div>
          <div class="surface">
            <div class="section-head"><h2>Category mix</h2><span>Debit / spend share</span></div>
            ${svgDonut(categories, currency)}
            ${
              a.name_check
                ? `<div style="margin-top:14px">${kvRows([
                    ["Name check", a.name_check.message || (a.name_check.value ? "Match" : "Weak")],
                    ["Account name", a.name_check.account_name || st.account_name || "—"],
                    ["Match score", String(a.name_check.score ?? "—")],
                  ])}</div>`
                : ""
            }
          </div>
        </div>

        <div class="report-section" id="loans">
          <div class="surface">
            <div class="section-head"><h2>Loans & debt</h2><span>All detected disbursements & repayments</span></div>
            ${kvRows([
              ["Total disbursed", money(a.loans?.total_disbursed, currency)],
              ["Total repaid", money(a.loans?.total_repaid, currency)],
              ["Net debt (disbursed − repaid)", money(a.loans?.net_debt, currency)],
              ["Loan events", String(a.loans?.loan_count ?? loanEvents.length)],
              ["Last loan", a.loans?.last_loan_amount != null ? `${money(a.loans.last_loan_amount, currency)} · ${fmtDate(a.loans.last_loan_date)}` : "—"],
              [
                "Repayment coverage",
                a.loans?.repayment_coverage != null
                  ? `${pct(Number(a.loans.repayment_coverage) * 100, 0)} of disbursed amounts repaid in-window`
                  : "—",
              ],
              ["Lenders", (a.loans?.lenders || []).join(", ") || "—"],
            ])}
            ${
              loanEvents.length
                ? `<div class="tx-scroll loan-table-wrap" style="margin-top:14px;max-height:420px">
                <table class="tx-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Lender</th>
                      <th>Narration</th>
                      <th class="num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>${loanEvents
                    .map(
                      (e) => `<tr>
                      <td>${fmtDate(e.date)}</td>
                      <td>${esc(e.side === "disbursement" ? "Disbursed" : "Repaid")}</td>
                      <td>${esc(e.lender || "—")}</td>
                      <td class="narration">${esc(e.description || "—")}</td>
                      <td class="num ${e.side === "disbursement" ? "amt-c" : "amt-d"}">${money(e.amount, currency)}</td>
                    </tr>`,
                    )
                    .join("")}</tbody>
                  <tfoot>
                    <tr>
                      <td colspan="4"><strong>Table totals</strong> · ${loanEvents.filter((e) => e.side === "disbursement").length} disbursed · ${loanEvents.filter((e) => e.side === "repayment").length} repaid</td>
                      <td class="num"><div>In ${money(loanTableDisbursed, currency)}</div><div>Out ${money(loanTableRepaid, currency)}</div></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <p class="field-hint" style="margin-top:10px">Table totals match the summary above when every detected loan event is listed.</p>`
                : `<p class="limitations" style="margin-top:12px">No loan events detected in narrations.</p>`
            }

            <div style="margin-top:22px">
              <div class="section-head"><h2 style="font-size:1.05rem">When loans are disbursed &amp; repaid</h2><span>Day &amp; week timing</span></div>
              ${kvRows([
                ["Peak disbursement weekday", a.timing?.loans?.peak_disbursement_weekday || "—"],
                ["Peak repayment weekday", a.timing?.loans?.peak_repayment_weekday || "—"],
                [
                  "Peak disbursement week",
                  a.timing?.loans?.peak_disbursement_week_of_month != null
                    ? `Week ${a.timing.loans.peak_disbursement_week_of_month}`
                    : "—",
                ],
                [
                  "Peak repayment week",
                  a.timing?.loans?.peak_repayment_week_of_month != null
                    ? `Week ${a.timing.loans.peak_repayment_week_of_month}`
                    : "—",
                ],
                [
                  "Peak disbursement day of month",
                  a.timing?.loans?.peak_disbursement_day_of_month != null
                    ? `Day ${a.timing.loans.peak_disbursement_day_of_month}`
                    : "—",
                ],
                [
                  "Peak repayment day of month",
                  a.timing?.loans?.peak_repayment_day_of_month != null
                    ? `Day ${a.timing.loans.peak_repayment_day_of_month}`
                    : "—",
                ],
              ])}
              <div class="grid-2" style="margin-top:14px">
                <div>
                  <div class="section-head"><h2 style="font-size:1rem">By weekday</h2><span>Disbursed vs repaid</span></div>
                  ${svgDualBarChart(
                    (a.timing?.loans?.by_weekday || []).map((w) => ({
                      label: w.label,
                      credit_total: w.disbursed,
                      debit_total: w.repaid,
                    })),
                    {
                      aria: "Loan activity by weekday",
                      labelA: "Disbursed",
                      labelB: "Repaid",
                    },
                  )}
                </div>
                <div>
                  <div class="section-head"><h2 style="font-size:1rem">By week of month</h2><span>W1–W4 totals</span></div>
                  ${svgDualBarChart(
                    (a.timing?.loans?.week_of_month_totals || []).map((w) => ({
                      label: `W${w.week}`,
                      credit_total: w.disbursed,
                      debit_total: w.repaid,
                    })),
                    {
                      aria: "Loan activity by week of month",
                      labelA: "Disbursed",
                      labelB: "Repaid",
                    },
                  )}
                </div>
              </div>
              <div style="margin-top:14px">
                <div class="section-head"><h2 style="font-size:1rem">By day of month</h2><span>Repayment / disbursement days</span></div>
                ${svgDualBarChart(
                  (a.timing?.loans?.by_day_of_month || []).map((d) => ({
                    label: d.label,
                    credit_total: d.disbursed,
                    debit_total: d.repaid,
                  })),
                  {
                    aria: "Loan activity by day of month",
                    labelA: "Disbursed",
                    labelB: "Repaid",
                  },
                )}
              </div>
              <div style="margin-top:18px">
                <div class="section-head"><h2 style="font-size:1rem">Loan history by week</h2><span>6-month style week grid</span></div>
                ${weekMatrixTable(a.timing?.loans?.week_of_month || a.timing?.week_of_month || [], currency, {
                  depositKey: "loan_disbursed",
                  withdrawKey: "loan_repaid",
                  depositLabel: "Disbursed",
                  withdrawLabel: "Repaid",
                  emptyText: "No loan disbursements or repayments by week.",
                })}
              </div>
            </div>
          </div>
        </div>

        <div class="report-section" id="patterns">
          <div class="surface">
            <div class="section-head"><h2>Transaction patterns</h2><span>Risk & concentration</span></div>
            ${kvRows([
              ["1-day credit concentration", pct(spike.one_day_pct_of_credits)],
              ["3-day credit concentration", pct(spike.three_day_pct_of_credits)],
              ["30-day credit concentration", pct(spike.thirty_day_pct_of_credits)],
              ["Concentrated inflow", spike.concentrated_inflow ? "Yes" : "No"],
              [
                "Average deposit sweep",
                sweepPct == null
                  ? "—"
                  : `${sweepPct.toFixed(0)}% of monthly deposits left as withdrawals (100% = fully spent; over 100% = spent more than came in)`,
              ],
              [
                "Heavy-sweep months",
                `${a.behavior?.high_sweep_months ?? 0} month(s) where ≥90% of deposits were withdrawn`,
              ],
              ["Days bal > 20% avg deposit", String(a.behavior?.balance_persistence?.days_above_20pct_avg_deposit ?? "—")],
              ["Days bal > 50% avg deposit", String(a.behavior?.balance_persistence?.days_above_50pct_avg_deposit ?? "—")],
              ["Estimated DTI", a.totals?.estimated_dti != null ? Number(a.totals.estimated_dti).toFixed(2) : "—"],
            ])}
            ${
              bands.length
                ? `<div style="margin-top:14px"><div class="section-head"><h2 style="font-size:1rem">Deposit size bands</h2></div>
                ${kvRows(bands.map(([k, v]) => [k, String(v)]))}</div>`
                : ""
            }
            ${
              risks.length
                ? `<div class="pill-row" style="margin-top:14px">${risks
                    .map((r) => `<span class="pill warn">${esc(r.code || r.value)} · ${pct((r.confidence || 0) * 100, 0)}</span>`)
                    .join("")}</div>`
                : ""
            }
          </div>
        </div>

        <div class="grid-2 report-section" id="spend">
          <div class="surface">
            <div class="section-head"><h2>Spend breakdown</h2><span>Outflows (debits)</span></div>
            ${(() => {
              const gambleCat = (a.categories || []).find((c) => c.category === "gambling");
              const gambleIn =
                a.spend?.total_gambling_inflow ?? gambleCat?.credit_total ?? 0;
              return kvRows([
                ["ATM", money(a.spend?.total_atm, currency)],
                ["POS", money(a.spend?.total_pos, currency)],
                ["Gambling spend", money(a.spend?.total_gambling, currency)],
                ["Gambling inflows", money(gambleIn, currency)],
                ["Entertainment", money(a.spend?.total_entertainment, currency)],
                ["Religion", money(a.spend?.total_religion, currency)],
                ["Airtime", money(a.spend?.total_airtime, currency)],
                ["Utilities", money(a.spend?.total_utility, currency)],
                ["Investment", money(a.spend?.total_investment, currency)],
                ["Bank charges", money(a.spend?.total_bank_charges, currency)],
              ]);
            })()}
          </div>
          <div class="surface" id="counterparties">
            <div class="section-head"><h2>Counterparties</h2><span>${esc(String(a.counterparties?.sender_count ?? 0))} senders · ${esc(String(a.counterparties?.recipient_count ?? 0))} recipients</span></div>
            ${(() => {
              const rows = [
                ...(a.counterparties?.top_senders || [])
                  .slice(0, 6)
                  .map((p) => [`In · ${p.name}`, `${p.count}× · ${money(p.total, currency)}`]),
                ...(a.counterparties?.top_recipients || [])
                  .slice(0, 6)
                  .map((p) => [`Out · ${p.name}`, `${p.count}× · ${money(p.total, currency)}`]),
              ];
              return kvRows(rows.length ? rows : [["Counterparties", "None detected"]]);
            })()}
          </div>
        </div>

        <div class="surface report-section" id="score">
          <div class="section-head"><h2>Score factors</h2><span>How the ${score == null ? "—" : esc(String(score))} score was built</span></div>
          <p class="field-hint" style="margin-bottom:14px">
            Starts at 50. Each factor adds or subtracts points (already confidence-weighted). Positive helps; negative hurts.
          </p>
          <div class="table-wrap">
            <table class="tx-table factor-table">
              <thead>
                <tr>
                  <th>Factor</th>
                  <th>What it means</th>
                  <th>Direction</th>
                  <th class="num">Score impact</th>
                  <th class="num">Confidence</th>
                </tr>
              </thead>
              <tbody>
                ${(a.score_factors || [])
                  .map((f) => {
                    const pts = Number(f.points) || 0;
                    const dir =
                      pts > 0 ? "Helps" : pts < 0 ? "Hurts" : "Neutral";
                    const dirCls = pts > 0 ? "amt-c" : pts < 0 ? "amt-d" : "";
                    return `<tr>
                      <td><strong>${esc(f.label || f.code || "Factor")}</strong></td>
                      <td>${esc(f.detail || "—")}</td>
                      <td class="${dirCls}">${dir}</td>
                      <td class="num pts" style="color:${pts >= 0 ? "var(--foam)" : "#ffb0a6"}">${pts >= 0 ? "+" : ""}${esc(String(pts))}</td>
                      <td class="num">${pct((f.confidence || 0) * 100, 0)}</td>
                    </tr>`;
                  })
                  .join("") || `<tr><td colspan="5" class="muted">No factors.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <div class="surface report-section" id="ledger">
          <div class="section-head">
            <h2>Full ledger</h2>
            <span>${ledger.filtered.length.toLocaleString("en-NG")} of ${(data.transactions || []).length.toLocaleString("en-NG")} shown after filters</span>
          </div>
          <div class="toolbar">
            <div class="field grow">
              <label for="ledger-q">Search narration</label>
              <input id="ledger-q" type="search" value="${esc(state.ledgerQ)}" placeholder="Transfer, POS, lender name…" />
            </div>
            <div class="field">
              <label for="ledger-side">Side</label>
              <select id="ledger-side">
                <option value="all" ${state.ledgerSide === "all" ? "selected" : ""}>All</option>
                <option value="debit" ${state.ledgerSide === "debit" ? "selected" : ""}>Debits</option>
                <option value="credit" ${state.ledgerSide === "credit" ? "selected" : ""}>Credits</option>
              </select>
            </div>
          </div>
          <div class="tx-scroll">
            <table class="tx-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Debit</th>
                  <th>Credit</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>${ledger.html || `<tr><td colspan="5">No matching transactions.</td></tr>`}</tbody>
            </table>
          </div>
          <div class="pager">
            <span>Page ${state.ledgerPage + 1} of ${ledger.pages} · rows ${ledger.filtered.length ? ledger.start + 1 : 0}–${Math.min(ledger.start + PAGE_SIZE, ledger.filtered.length)}</span>
            <div class="btns">
              <button class="btn btn-ghost btn-sm" type="button" id="ledger-prev" ${state.ledgerPage <= 0 ? "disabled" : ""}>Previous</button>
              <button class="btn btn-ghost btn-sm" type="button" id="ledger-next" ${state.ledgerPage >= ledger.pages - 1 ? "disabled" : ""}>Next</button>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>`;
}

/* ---------- bind / lifecycle ---------- */

function setView(view) {
  state.view = view;
  render();
}

function readOptionalAnalysisFields(prefix) {
  const owner = document.getElementById(`${prefix}owner-name`)?.value?.trim() || "";
  const periodStart = document.getElementById(`${prefix}period-start`)?.value || "";
  const periodEnd = document.getElementById(`${prefix}period-end`)?.value || "";
  state.ownerName = owner;
  state.periodStart = periodStart;
  state.periodEnd = periodEnd;
  return { owner, periodStart, periodEnd };
}

function render() {
  const root = $app();
  if (!root) return;
  if (state.view === "login") root.innerHTML = renderLogin();
  else if (state.view === "report") root.innerHTML = renderReport();
  else if (state.view === "search") root.innerHTML = renderSearch();
  else if (state.view === "users") root.innerHTML = renderUsers();
  else root.innerHTML = renderDashboard();
  bind();
  saveUiSession();
  requestAnimationFrame(() => {
    document.querySelectorAll(".bar-fill[data-w]").forEach((el) => {
      el.style.width = `${el.getAttribute("data-w")}%`;
    });
    const ring = document.querySelector(".score-ring .value");
    if (ring instanceof SVGCircleElement) {
      const target = ring.style.strokeDashoffset;
      ring.style.strokeDashoffset = String(CIRC);
      requestAnimationFrame(() => {
        ring.style.strokeDashoffset = target;
      });
    }
    setupTocSpy();
    bindInteractiveCharts();
    if (state.view === "report") {
      window.scrollTo(0, 0);
    }
  });
}

/** Clear prior report so a new run never shows stale analysis mid-flight. */
function beginFreshRun() {
  state.result = null;
  state.runId = null;
  state.error = "";
  state.ledgerQ = "";
  state.ledgerSide = "all";
  state.ledgerPage = 0;
  state.exportOpen = false;
  state.notes = "";
  state.stage = 0;
  state.view = "dashboard";
  try {
    sessionStorage.setItem(
      UI_SESSION_KEY,
      JSON.stringify({
        view: "dashboard",
        runId: null,
        referenceId: null,
        runTab: state.runTab,
        searchQ: state.searchQ,
        searchOwner: state.searchOwner,
        searchRef: state.searchRef,
        searchResults: state.searchResults,
        searchTotal: state.searchTotal,
        searchTried: state.searchTried,
        ledgerQ: "",
        ledgerSide: "all",
        ledgerPage: 0,
      }),
    );
  } catch {
    /* ignore */
  }
}

function setupTocSpy() {
  if (state._tocObserver) {
    state._tocObserver.disconnect();
    state._tocObserver = null;
  }
  const links = [...document.querySelectorAll(".report-toc a[data-toc]")];
  if (!links.length) return;
  const sections = TOC.map(([id]) => document.getElementById(id)).filter(Boolean);
  const io = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      links.forEach((a) => a.classList.toggle("active", a.getAttribute("data-toc") === visible.target.id));
    },
    { rootMargin: "-20% 0px -60% 0px", threshold: [0.1, 0.4] },
  );
  sections.forEach((s) => io.observe(s));
  state._tocObserver = io;
}

function startStages() {
  state.stage = 0;
  if (state._stageTimer) clearInterval(state._stageTimer);
  state._stageTimer = setInterval(() => {
    if (!state.busy) {
      clearInterval(state._stageTimer);
      return;
    }
    if (state.stage < STAGES.length - 1) {
      state.stage += 1;
      const box = document.querySelector(".progress-stages");
      if (box) {
        // lightweight refresh of stages only
        const wrap = document.createElement("div");
        wrap.innerHTML = progressHtml();
        box.replaceWith(wrap.firstElementChild);
      }
    }
  }, 2200);
}

function stopStages() {
  if (state._stageTimer) clearInterval(state._stageTimer);
  state.stage = STAGES.length - 1;
}

async function openResult(result, sourceLabel) {
  // Always start from a clean report slot (never reuse prior runId/result).
  state.result = result;
  state.runId = null;
  state.ledgerQ = "";
  state.ledgerSide = "all";
  state.ledgerPage = 0;
  state.exportOpen = false;
  state.notes = "";
  try {
    await persistRun(result, sourceLabel);
  } catch {
    state.runId = uid();
  }
  state.notes = loadNotes(state.runId);
  state.view = "report";
  saveUiSession();
}

function bind() {
  document.getElementById("login-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = String(fd.get("email") || "");
    const password = String(fd.get("password") || "");
    state.busy = true;
    state.error = "";
    render();
    try {
      const data = await api("/api/v1/auth/login", {
        method: "POST",
        body: { email, password },
      });
      state.user = data.user;
      state.history = loadHistoryMeta();
      const restored = await restoreUiSession();
      if (!restored) state.view = "dashboard";
    } catch (err) {
      state.error = err.message || "Login failed";
      state.view = "login";
    } finally {
      state.busy = false;
      render();
    }
  });

  document.getElementById("logout-btn")?.addEventListener("click", async () => {
    try {
      await api("/api/v1/auth/logout", { method: "POST", body: {} });
    } catch {
      /* ignore */
    }
    clearUiSession();
    state.user = null;
    state.result = null;
    state.runId = null;
    state.view = "login";
    state.error = "";
    render();
  });

  document.getElementById("back-dash")?.addEventListener("click", () => {
    state.result = null;
    state.runId = null;
    state.file = null;
    state.error = "";
    state.history = loadHistoryMeta();
    setView("dashboard");
  });

  document.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nav = btn.getAttribute("data-nav");
      state.error = "";
      state.userFormError = "";
      state.userFormOk = "";
      if (nav === "search") {
        state.view = "search";
        render();
        return;
      }
      if (nav === "users") {
        state.view = "users";
        render();
        void loadUsers();
        return;
      }
      state.history = loadHistoryMeta();
      setView("dashboard");
    });
  });

  document.getElementById("add-user-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    state.busy = true;
    state.userFormError = "";
    state.userFormOk = "";
    state.error = "";
    render();
    try {
      await api("/api/v1/auth/users", {
        method: "POST",
        body: {
          name: String(fd.get("name") || "").trim() || undefined,
          email: String(fd.get("email") || ""),
          password: String(fd.get("password") || ""),
        },
      });
      state.userFormOk = "User added. They can sign in with that email and password.";
      await loadUsers({ silent: true });
    } catch (err) {
      state.userFormError = err.message || "Could not add user";
    } finally {
      state.busy = false;
      render();
    }
  });

  document.getElementById("search-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    state.searchQ = document.getElementById("search-q")?.value?.trim() || "";
    state.searchOwner = document.getElementById("search-owner")?.value?.trim() || "";
    state.searchRef = document.getElementById("search-ref")?.value?.trim() || "";
    if (!state.searchQ && !state.searchOwner && !state.searchRef) {
      state.error = "Enter a name, reference ID, or search text.";
      state.searchTried = false;
      state.searchResults = [];
      state.searchTotal = 0;
      render();
      return;
    }
    state.busy = true;
    state.error = "";
    render();
    try {
      const params = new URLSearchParams();
      if (state.searchQ) params.set("q", state.searchQ);
      if (state.searchOwner) params.set("owner", state.searchOwner);
      if (state.searchRef) params.set("reference_id", state.searchRef);
      const data = await api(`/api/v1/analyses/search?${params.toString()}`);
      state.searchResults = data.results || [];
      state.searchTotal = data.total ?? state.searchResults.length;
      state.searchTried = true;
    } catch (err) {
      state.error = err.message || "Search failed";
      state.searchResults = [];
      state.searchTotal = 0;
      state.searchTried = true;
    } finally {
      state.busy = false;
      render();
    }
  });

  document.querySelectorAll(".search-card[data-ref]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ref = btn.getAttribute("data-ref");
      state.busy = true;
      state.error = "";
      render();
      try {
        const data = await api(`/api/v1/analyses/${encodeURIComponent(ref)}`);
        await openResult(data.result, `Ref ${ref}`);
      } catch (err) {
        state.error = err.message || "Could not open analysis";
        state.view = "search";
      } finally {
        state.busy = false;
        render();
      }
    });
  });

  document.querySelectorAll(".tab[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.runTab = btn.getAttribute("data-tab") === "url" ? "url" : "upload";
      state.error = "";
      render();
    });
  });

  const drop = document.getElementById("dropzone");
  const fileInput = document.getElementById("file-input");
  if (drop && fileInput) {
    const pick = () => fileInput.click();
    drop.addEventListener("click", pick);
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pick();
      }
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("drag");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("drag");
      const f = e.dataTransfer?.files?.[0];
      if (f) {
        state.file = f;
        render();
      }
    });
    fileInput.addEventListener("change", () => {
      state.file = fileInput.files?.[0] || null;
      render();
    });
  }

  document.getElementById("run-upload")?.addEventListener("click", () => runUpload());
  document.getElementById("url-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    runUrl();
  });
  document.getElementById("sample-report-btn")?.addEventListener("click", () => loadSampleReport());

  document.querySelectorAll(".history-item[data-run]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-run");
      try {
        const rec = await idbGet(id);
        if (!rec?.result) throw new Error("Run payload missing — re-run analysis");
        state.runId = id;
        state.result = rec.result;
        state.notes = loadNotes(id);
        state.ledgerQ = "";
        state.ledgerSide = "all";
        state.ledgerPage = 0;
        state.view = "report";
        render();
      } catch (err) {
        state.error = err.message || "Could not open run";
        render();
      }
    });
  });

  // report controls — partial re-renders avoided; full render ok for page size
  const q = document.getElementById("ledger-q");
  if (q) {
    let t;
    q.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.ledgerQ = q.value;
        state.ledgerPage = 0;
        render();
        document.getElementById("ledger-q")?.focus();
        const el = document.getElementById("ledger-q");
        if (el) {
          const len = el.value.length;
          el.setSelectionRange(len, len);
        }
      }, 220);
    });
  }
  document.getElementById("ledger-side")?.addEventListener("change", (e) => {
    state.ledgerSide = e.target.value;
    state.ledgerPage = 0;
    render();
  });
  document.getElementById("ledger-prev")?.addEventListener("click", () => {
    state.ledgerPage -= 1;
    render();
    document.getElementById("ledger")?.scrollIntoView({ block: "start" });
  });
  document.getElementById("ledger-next")?.addEventListener("click", () => {
    state.ledgerPage += 1;
    render();
    document.getElementById("ledger")?.scrollIntoView({ block: "start" });
  });

  document.getElementById("export-toggle")?.addEventListener("click", () => {
    state.exportOpen = !state.exportOpen;
    document.getElementById("export-menu")?.classList.toggle("open", state.exportOpen);
  });
  document.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-export");
      state.exportOpen = false;
      doExport(kind);
      document.getElementById("export-menu")?.classList.remove("open");
    });
  });

}

function doExport(kind) {
  const data = state.result;
  if (!data) return;
  const name = (data.statement?.account_name || "statement").replace(/\s+/g, "_").slice(0, 40);
  if (kind === "print") {
    window.print();
    return;
  }
  if (kind === "json") {
    downloadText(`${name}_analysis.json`, JSON.stringify(data, null, 2));
    return;
  }
  if (kind === "csv") {
    const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["date", "description", "debit", "credit", "balance", "type"]];
    for (const t of data.transactions || []) {
      rows.push([
        t.transaction_date || t.value_date || "",
        t.description || "",
        t.debit ?? "",
        t.credit ?? "",
        t.balance ?? "",
        t.transaction_type || "",
      ]);
    }
    const csv = rows.map((r) => r.map(cell).join(",")).join("\n");
    downloadText(`${name}_ledger.csv`, csv, "text/csv");
  }
}

async function runUpload() {
  if (!state.file || state.busy) return;
  const opts = readOptionalAnalysisFields("up-");
  beginFreshRun();
  state.busy = true;
  state.error = "";
  startStages();
  render();
  try {
    const fd = new FormData();
    fd.append("file", state.file);
    // Desk "Run analysis" always re-extracts; never silently replay a cached hash.
    fd.append("force", "true");
    const pw = document.getElementById("pdf-password")?.value;
    if (pw) fd.append("password", pw);
    if (opts.owner) fd.append("owner_name", opts.owner);
    if (opts.periodStart) fd.append("period_start", opts.periodStart);
    if (opts.periodEnd) fd.append("period_end", opts.periodEnd);
    const data = await api("/api/v1/statements/extract", { method: "POST", body: fd });
    stopStages();
    await openResult(data, state.file.name);
  } catch (err) {
    state.error = err.message || "Extraction failed";
    state.view = "dashboard";
  } finally {
    state.busy = false;
    stopStages();
    render();
  }
}

async function runUrl() {
  if (state.busy) return;
  const url = document.getElementById("stmt-url")?.value?.trim();
  if (!url) return;
  const opts = readOptionalAnalysisFields("url-");
  beginFreshRun();
  state.busy = true;
  state.error = "";
  startStages();
  render();
  try {
    const password = document.getElementById("url-password")?.value || undefined;
    const data = await api("/api/v1/statements/extract-url", {
      method: "POST",
      body: {
        source_type: "url",
        url,
        password,
        force: true,
        owner_name: opts.owner || null,
        period_start: opts.periodStart || null,
        period_end: opts.periodEnd || null,
      },
    });
    stopStages();
    await openResult(data, "URL");
  } catch (err) {
    state.error = err.message || "Extraction failed";
    state.view = "dashboard";
  } finally {
    state.busy = false;
    stopStages();
    render();
  }
}

async function loadSampleReport() {
  if (state.busy) return;
  beginFreshRun();
  state.busy = true;
  state.error = "";
  startStages();
  render();
  try {
    const data = await api("/api/v1/auth/sample-report");
    stopStages();
    await openResult(data, "Sample");
  } catch (err) {
    state.error = err.message || "Sample report unavailable";
    state.view = "dashboard";
  } finally {
    state.busy = false;
    stopStages();
    render();
  }
}

async function boot() {
  state.history = loadHistoryMeta();
  try {
    const me = await api("/api/v1/auth/me");
    state.user = me.user;
    const restored = await restoreUiSession();
    if (!restored) state.view = "dashboard";
    if (state.view === "users") void loadUsers({ silent: true });
  } catch {
    state.user = null;
    state.view = "login";
  }
  render();
}

boot();
