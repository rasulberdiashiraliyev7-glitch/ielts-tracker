/* =====================================================================
   IELTS Progress Tracker — vanilla JS, data persisted in localStorage
   ===================================================================== */

const STORAGE_KEY = 'ielts_tracker_v1';
const BUILD = '22';

const SKILLS = [
  { key: 'listening', name: 'Listening', color: '#0ea5e9', short: 'L' },
  { key: 'reading',   name: 'Reading',   color: '#0d9488', short: 'R' },
  { key: 'writing',   name: 'Writing',   color: '#f59e0b', short: 'W' },
  { key: 'speaking',  name: 'Speaking',  color: '#8b5cf6', short: 'S' },
];

/* ---------- Band conversion (IELTS Academic, raw /40 -> band) ---------- */
function bandFromTable(raw, table) {
  if (raw == null || isNaN(raw)) return null;
  for (const [min, band] of table) if (raw >= min) return band;
  return 0;
}
const LISTENING_TABLE = [
  [39,9],[37,8.5],[35,8],[32,7.5],[30,7],[26,6.5],[23,6],
  [18,5.5],[16,5],[13,4.5],[11,4],[8,3.5],[6,3],[4,2.5],[1,2],
];
const READING_TABLE = [
  [39,9],[37,8.5],[35,8],[33,7.5],[30,7],[27,6.5],[23,6],
  [19,5.5],[15,5],[13,4.5],[10,4],[8,3.5],[6,3],[4,2.5],[1,2],
];
const listeningBand = raw => bandFromTable(raw, LISTENING_TABLE);
const readingBand   = raw => bandFromTable(raw, READING_TABLE);

/* round to nearest 0.5 (IELTS rule: .25 -> .5, .75 -> next whole) */
const roundHalf = x => Math.round(x * 2) / 2;
const fmtBand = b => (b == null ? '—' : Number(b).toFixed(1));

const DEFAULT_TARGETS = { listening: 7, reading: 7, writing: 6.5, speaking: 6.5 };

/* ---------- State ---------- */
let state = { targets: { ...DEFAULT_TARGETS }, attempts: [] };
let chart = null;
let lastAttemptTimestamp = 0;
let attemptSerial = 0;

/* ---------- Cloud / auth globals (Firebase REST — Google infra) ---------- */
let currentUser = null;   // { uid, fullName, email, role, idToken, refreshToken, expiresAt }
let cloudTimer = null;
const SESSION_KEY = 'ielts_session_v2';

function normalizeState(data) {
  const s = (data && typeof data === 'object') ? data : {};
  if (!s.targets) s.targets = { ...DEFAULT_TARGETS };
  if (!Array.isArray(s.attempts)) s.attempts = [];
  return s;
}

/* HTTP request whose timeout covers BOTH the headers AND the body read.
   (Reading the body separately was un-timed, so a proxy that stalls the
   response body could freeze the UI on "Please wait..." forever.)
   Retries once on a transient network drop. */
/* visible on-screen log for diagnosing the sign-in flow */
function dlog(msg) {
  const el = document.getElementById('authLog');
  if (!el) return;
  const lines = (el.textContent ? el.textContent.split('\n') : []);
  lines.push(msg);
  el.textContent = lines.slice(-9).join('\n');
}

async function httpRequest(url, opts, attempt) {
  attempt = attempt || 1;
  const tag = (url.split('?')[0].split('/').pop() || '').split(':').pop().slice(0, 18);
  const t0 = Date.now();
  dlog('→ ' + ((opts && opts.method) || 'GET') + ' ' + tag + (attempt > 1 ? ' (retry)' : ''));
  try {
    const out = await withTimeout((async () => {
      const res = await fetch(url, opts);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    })(), 10000);
    dlog('← ' + tag + ' HTTP ' + out.status + ' (' + (Date.now() - t0) + 'ms)');
    return out;
  } catch (e) {
    dlog('✗ ' + tag + ': ' + (e.message || 'error').slice(0, 26) + ' (' + (Date.now() - t0) + 'ms)');
    const transient = /failed to fetch|networkerror|load failed|timed out/i.test(e.message || '');
    if (transient && attempt < 2) {
      await new Promise(r => setTimeout(r, 600 * attempt));
      return httpRequest(url, opts, attempt + 1);
    }
    throw e;
  }
}
function parseJson(text) { try { return JSON.parse(text); } catch (e) { return {}; } }

async function jsonPost(url, body) {
  const r = await httpRequest(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = parseJson(r.text);
  if (!r.ok) {
    const err = new Error((data.error && data.error.message) || ('HTTP ' + r.status));
    err.code = (data.error && data.error.message) || ''; throw err;
  }
  return data;
}

/* ---- Firebase Authentication (Identity Toolkit) REST ---- */
function fbKey() { return window.FIREBASE_API_KEY; }
function authUrl(method) { return 'https://identitytoolkit.googleapis.com/v1/accounts:' + method + '?key=' + fbKey(); }
async function fbSignUp(email, password) { return jsonPost(authUrl('signUp'), { email, password, returnSecureToken: true }); }
async function fbSignIn(email, password) { return jsonPost(authUrl('signInWithPassword'), { email, password, returnSecureToken: true }); }
async function fbRefresh(refreshToken) {
  const d = await jsonPost('https://securetoken.googleapis.com/v1/token?key=' + fbKey(),
    { grant_type: 'refresh_token', refresh_token: refreshToken });
  return { idToken: d.id_token, refreshToken: d.refresh_token, uid: d.user_id, expiresIn: +d.expires_in };
}
async function ensureToken() {
  if (!currentUser) throw new Error('Not signed in');
  if (Date.now() < currentUser.expiresAt - 60000) return currentUser.idToken;
  const r = await fbRefresh(currentUser.refreshToken);
  currentUser.idToken = r.idToken;
  currentUser.refreshToken = r.refreshToken || currentUser.refreshToken;
  currentUser.expiresAt = Date.now() + r.expiresIn * 1000;
  saveSession();
  return currentUser.idToken;
}

/* ---- Firestore REST (store the whole state as a JSON string field) ---- */
function fsBase() {
  return 'https://firestore.googleapis.com/v1/projects/' + window.FIREBASE_PROJECT_ID +
         '/databases/' + (window.FIREBASE_DB_ID || '(default)') + '/documents';
}
function encodeFields(o) {
  const f = {};
  if (o.full_name != null) f.full_name = { stringValue: o.full_name };
  if (o.email != null) f.email = { stringValue: o.email };
  if (o.is_admin != null) f.is_admin = { booleanValue: !!o.is_admin };
  if (o.data != null) f.data = { stringValue: JSON.stringify(o.data) };
  if (o.updated_at != null) f.updated_at = { stringValue: o.updated_at };
  return f;
}
function decodeDoc(doc) {
  const f = doc.fields || {};
  let data = {};
  try { data = JSON.parse((f.data && f.data.stringValue) || '{}'); } catch (e) {}
  return {
    uid: doc.name.split('/').pop(),
    full_name: (f.full_name && f.full_name.stringValue) || '',
    email: (f.email && f.email.stringValue) || '',
    is_admin: !!(f.is_admin && f.is_admin.booleanValue),
    data: normalizeState(data),
    updated_at: (f.updated_at && f.updated_at.stringValue) || '',
  };
}
async function fsGetUser(uid) {
  const token = await ensureToken();
  const r = await httpRequest(fsBase() + '/users/' + uid, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) return null;
  const data = parseJson(r.text);
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  return decodeDoc(data);
}
async function fsSetUser(uid, fields, mask) {
  const token = await ensureToken();
  let url = fsBase() + '/users/' + uid;
  if (mask && mask.length) url += '?' + mask.map(m => 'updateMask.fieldPaths=' + m).join('&');
  const r = await httpRequest(url, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: encodeFields(fields) }),
  });
  if (!r.ok) { const d = parseJson(r.text); throw new Error((d.error && d.error.message) || ('HTTP ' + r.status)); }
  return parseJson(r.text);
}
async function fsListUsers() {
  const token = await ensureToken();
  const r = await httpRequest(fsBase() + '/users?pageSize=500', { headers: { Authorization: 'Bearer ' + token } });
  const data = parseJson(r.text);
  if (!r.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + r.status));
  return (data.documents || []).map(decodeDoc);
}

/* save = local cache (per user) + debounced cloud save */
function save() {
  if (currentUser) {
    try { localStorage.setItem(STORAGE_KEY + ':' + currentUser.uid, JSON.stringify(state)); } catch (e) {}
    scheduleCloudSave();
  }
}
function scheduleCloudSave() {
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(cloudSaveNow, 800);
}
async function cloudSaveNow() {
  if (!currentUser) return;
  try { await fsSetUser(currentUser.uid, { data: state, updated_at: new Date().toISOString() }, ['data', 'updated_at']); }
  catch (e) { /* keep local copy; retries on next change */ }
}

/* ---------- Helpers ---------- */
function sortedAttempts() {
  return [...state.attempts].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
}
function overallOf(att) {
  const vals = SKILLS.map(s => att[s.key]?.band).filter(v => v != null);
  if (!vals.length) return null;
  return roundHalf(vals.reduce((a, b) => a + b, 0) / vals.length);
}
function latestBand(skillKey) {
  const list = sortedAttempts().filter(a => a[skillKey]?.band != null);
  return list.length ? list[list.length - 1][skillKey].band : null;
}
function latestOverall() {
  const list = sortedAttempts().map(overallOf).filter(v => v != null);
  return list.length ? list[list.length - 1] : null;
}
function targetOverall() {
  const t = state.targets;
  return roundHalf((t.listening + t.reading + t.writing + t.speaking) / 4);
}

/* =====================================================================
   RENDER
   ===================================================================== */
function render() {
  renderTargets();
  renderRing();
  renderChips();
  renderSkillProgress();
  renderMotivation();
  renderHistory();
  renderChart();
}

/* ----- Target inputs ----- */
function renderTargets() {
  const wrap = document.getElementById('targetInputs');
  wrap.innerHTML = '';
  SKILLS.forEach(s => {
    const item = document.createElement('div');
    item.className = 'target-item';
    item.innerHTML = `
      <label><span class="skill-dot" style="--c:${s.color}"></span>${s.name}</label>
      <select data-skill="${s.key}">${bandOptions(state.targets[s.key])}</select>`;
    wrap.appendChild(item);
  });
  wrap.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', e => {
      state.targets[e.target.dataset.skill] = parseFloat(e.target.value);
      save(); render();
    });
  });
}
function bandOptions(selected, min = 4) {
  let html = '';
  for (let b = min; b <= 9; b += 0.5) {
    html += `<option value="${b}" ${b === selected ? 'selected' : ''}>${b.toFixed(1)}</option>`;
  }
  return html;
}

/* ----- Overall ring ----- */
function renderRing() {
  const current = latestOverall();
  const target = targetOverall();
  const C = 2 * Math.PI * 84; // circumference

  const ratio = current == null ? 0 : Math.min(current / target, 1);
  document.getElementById('ringFill').style.strokeDashoffset = C * (1 - ratio);
  document.getElementById('ringTarget').textContent = fmtBand(target);
  document.getElementById('ringCurrent').textContent = current == null ? '—' : fmtBand(current);
  document.getElementById('testCount').textContent = state.attempts.length;
  document.getElementById('overallTarget').textContent = fmtBand(target);

  const toGo = current == null ? null : Math.max(0, roundHalf(target - current));
  const el = document.getElementById('overallToGo');
  if (toGo == null) { el.textContent = '—'; }
  else if (toGo === 0) { el.textContent = 'Goal reached'; el.classList.remove('accent'); }
  else { el.textContent = `${fmtBand(toGo)} band`; el.classList.add('accent'); }
}

/* ----- Target chips ----- */
function renderChips() {
  const wrap = document.getElementById('targetChips');
  wrap.innerHTML = SKILLS.map(s =>
    `<span class="chip">${s.short}: ${state.targets[s.key].toFixed(1)}</span>`).join('');
}

/* ----- Skill progress bars ----- */
function renderSkillProgress() {
  const wrap = document.getElementById('skillProgress');
  wrap.innerHTML = '';
  SKILLS.forEach(s => {
    const cur = latestBand(s.key);
    const tgt = state.targets[s.key];
    const fillPct = cur == null ? 0 : Math.min(cur / 9 * 100, 100);
    const tgtPct = tgt / 9 * 100;

    let foot;
    if (cur == null) foot = `<span class="muted">No test logged yet</span>`;
    else if (cur >= tgt) foot = `<span class="done">✓ Target reached — great work!</span>`;
    else foot = `<span class="gap">${fmtBand(roundHalf(tgt - cur))} band to go</span> to hit your ${fmtBand(tgt)} goal`;

    const item = document.createElement('div');
    item.className = 'sp-item';
    item.innerHTML = `
      <div class="sp-top">
        <span class="skill-dot" style="--c:${s.color}"></span>
        <span class="sp-name">${s.name}</span>
        <span class="sp-values"><strong>${fmtBand(cur)}</strong> / ${fmtBand(tgt)}</span>
      </div>
      <div class="sp-track">
        <div class="sp-fill" style="--c:${s.color}"></div>
        <div class="sp-target" style="left:${tgtPct}%"></div>
      </div>
      <div class="sp-foot">${foot}</div>`;
    wrap.appendChild(item);

    // colour the track + fill with this skill's colour
    const track = item.querySelector('.sp-track');
    const fill = item.querySelector('.sp-fill');
    track.style.background = hexToRgba(s.color, 0.13);
    fill.style.background = `linear-gradient(90deg, ${hexToRgba(s.color, 0.6)}, ${s.color})`;

    // force a reflow at width:0, then set target width so the CSS transition animates
    void fill.offsetWidth;
    fill.style.width = fillPct + '%';
  });
}

/* hex (#rrggbb) -> rgba string */
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ----- Motivation card ----- */
function renderMotivation() {
  const title = document.getElementById('motivTitle');
  const text = document.getElementById('motivText');
  const n = state.attempts.length;
  if (n === 0) {
    title.textContent = 'Log your first test';
    text.textContent = 'Enter your scores on the right to start tracking your progress.';
    return;
  }
  // find weakest skill relative to target
  let worst = null;
  SKILLS.forEach(s => {
    const cur = latestBand(s.key);
    if (cur == null) return;
    const gap = state.targets[s.key] - cur;
    if (!worst || gap > worst.gap) worst = { name: s.name, gap, cur };
  });
  const cur = latestOverall();
  const tgt = targetOverall();
  if (cur != null && cur >= tgt) {
    title.textContent = 'Goal reached';
    text.textContent = `Your overall band ${fmtBand(cur)} meets your ${fmtBand(tgt)} target. Keep it steady before test day.`;
  } else if (worst && worst.gap > 0) {
    title.textContent = `Focus on ${worst.name}`;
    text.textContent = `It's your biggest gap (${fmtBand(roundHalf(worst.gap))} band). A little extra practice here lifts your overall fastest.`;
  } else {
    title.textContent = 'Steady progress';
    text.textContent = `${n} test${n > 1 ? 's' : ''} logged. Keep adding results to see your trend.`;
  }
}

/* ----- History table ----- */
function renderHistory() {
  const body = document.getElementById('historyBody');
  const empty = document.getElementById('historyEmpty');
  const summary = document.getElementById('historySummary');
  const list = sortedAttempts().reverse();
  body.innerHTML = '';
  empty.style.display = list.length ? 'none' : 'block';
  if (summary) {
    summary.textContent = list.length ? `${list.length} attempt${list.length === 1 ? '' : 's'} logged` : 'No attempts logged yet';
  }

  list.forEach(att => {
    const tr = document.createElement('tr');
    const cell = key => att[key]?.band != null ? fmtBand(att[key].band) : '<span class="muted">—</span>';
    const label = att.label || 'Untitled attempt';
    tr.innerHTML = `
      <td>${formatDate(att.date)}</td>
      <td class="muted">${att.label || '—'}</td>
      <td class="band-cell">${cell('listening')}</td>
      <td class="band-cell">${cell('reading')}</td>
      <td class="band-cell">${cell('writing')}</td>
      <td class="band-cell">${cell('speaking')}</td>
      <td class="band-overall">${fmtBand(overallOf(att))}</td>
      <td><button class="del-btn" data-id="${att.id}" title="Delete this test" aria-label="Delete ${escapeHtml(label)} from ${formatDate(att.date)}">Delete</button></td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('.del-btn').forEach(b => {
    b.addEventListener('click', () => deleteAttempt(b.dataset.id));
  });
}
function formatDate(d) {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ----- Growth chart (overall-first + per-skill drill-down) ----- */
let chartView = 'overall';
let chartSeries = 'all';
const CHART_TABS = [
  { key: 'overall', label: 'Overall' },
  { key: 'listening', label: 'Listening' },
  { key: 'reading', label: 'Reading' },
  { key: 'writing', label: 'Writing' },
  { key: 'speaking', label: 'Speaking' },
];
const CHART_COLOR_FALLBACKS = Object.freeze({
  '--listening': '#0ea5e9',
  '--reading': '#0d9488',
  '--writing': '#f59e0b',
  '--speaking': '#8b5cf6',
  '--accent-teal': '#0d9488',
  '--ink-strong': '#14293b',
  '--ink-muted': '#5f7180',
  '--line-default': '#dce7e8',
});

function resolveChartToken(token) {
  const fallback = CHART_COLOR_FALLBACKS[token] || CHART_COLOR_FALLBACKS['--ink-strong'];
  if (typeof document === 'undefined' || !document.documentElement || typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  return value || fallback;
}

function chartColors() {
  return {
    listening: resolveChartToken('--listening'),
    reading: resolveChartToken('--reading'),
    writing: resolveChartToken('--writing'),
    speaking: resolveChartToken('--speaking'),
    accent: resolveChartToken('--accent-teal'),
    ink: resolveChartToken('--ink-strong'),
    muted: resolveChartToken('--ink-muted'),
    grid: resolveChartToken('--line-default'),
  };
}

function lineDS(label, data, color, extra = {}) {
  return {
    label, data, borderColor: color, backgroundColor: color,
    tension: 0.2, spanGaps: true, borderWidth: 2.5, pointRadius: 3.5, pointHoverRadius: 6,
    fill: false, ...extra,
  };
}

function averageForParts(parts) {
  if (!Array.isArray(parts)) return null;
  const values = parts
    .filter(value => value != null && Number.isFinite(Number(value)))
    .map(Number);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function chartDatasetsForSeries(datasets, series) {
  if (!series || series === 'all') return datasets;
  const hasSeries = datasets.some(dataset => dataset.key === series);
  if (!hasSeries) return datasets;
  const keepAverage = dataset => dataset.key === 'average' && (
    series === 'average' || series.startsWith('section-') || series.startsWith('passage-')
  );
  return datasets.filter(dataset => dataset.key === series || dataset.key === 'target' || keepAverage(dataset));
}

function chartDateLabel(date) {
  if (!date) return 'Undated';
  const dt = new Date(date + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function chartLabels(list) {
  const totals = new Map();
  list.forEach((attempt, index) => {
    const date = attempt.date || `attempt-${index}`;
    totals.set(date, (totals.get(date) || 0) + 1);
  });
  const seen = new Map();
  return list.map((attempt, index) => {
    const date = attempt.date || `attempt-${index}`;
    const count = (seen.get(date) || 0) + 1;
    seen.set(date, count);
    const total = totals.get(date);
    return total > 1 ? `${chartDateLabel(attempt.date)} · #${count}` : chartDateLabel(attempt.date);
  });
}

function coverageFor(attempt) {
  if (!attempt) return 0;
  return SKILLS.reduce((count, skill) => count + (attempt[skill.key]?.band != null ? 1 : 0), 0);
}

function metricFor(attempt, view) {
  if (!attempt) return null;
  return view === 'overall' ? overallOf(attempt) : (attempt[view]?.band ?? null);
}

function latestComparable(list, view) {
  for (let i = list.length - 1; i >= 0; i--) {
    const value = metricFor(list[i], view);
    if (value != null) return { value, index: i, attempt: list[i] };
  }
  return null;
}

function previousComparable(list, view, index) {
  for (let i = index - 1; i >= 0; i--) {
    const value = metricFor(list[i], view);
    if (value != null) return value;
  }
  return null;
}

function formatChange(change) {
  if (change == null) return 'No previous result';
  if (change === 0) return 'No change';
  return `${change > 0 ? '+' : ''}${fmtBand(change)} band`;
}

function targetForView(view) {
  return view === 'overall' ? targetOverall() : state.targets[view];
}

function chartScrollBehavior() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ? 'auto' : 'smooth';
}

function chartAnimationDuration() {
  return chartScrollBehavior() === 'auto' ? 0 : 450;
}

const CHART_PATTERNS = [null, [7, 4], [2, 3], [11, 3, 2, 3]];

function patternFor(index) {
  const borderDash = CHART_PATTERNS[index % CHART_PATTERNS.length];
  return borderDash ? { borderDash } : {};
}

function bandAxis(values, target) {
  const bounds = bandBounds([{ label: 'Measured', data: values }], target);
  return { ...bounds, stepSize: 0.5, title: 'Band score', decimals: 1 };
}

function buildChartModel(attempts, view, targets) {
  const currentView = view === 'all' ? 'overall' : view;
  const targetSet = targets || state.targets;
  const colors = chartColors();
  const partColors = [colors.listening, colors.reading, colors.writing, colors.speaking];
  const target = currentView === 'overall'
    ? roundHalf(SKILLS.reduce((sum, skill) => sum + Number(targetSet[skill.key] ?? DEFAULT_TARGETS[skill.key]), 0) / SKILLS.length)
    : Number(targetSet[currentView] ?? DEFAULT_TARGETS[currentView]);
  const labels = chartLabels(attempts);
  let datasets;
  let axis;
  if (currentView === 'overall') {
    const average = attempts.map(overallOf);
    datasets = [
      lineDS('Attempt average', average, colors.accent, {
        key: 'overall',
        borderWidth: 3,
        pointRadius: average.map((value, index) => value == null ? 0 : index === average.length - 1 ? 6 : 3.5),
        pointHoverRadius: 7,
      }),
      lineDS('Target', attempts.map(() => target), colors.ink, { key: 'target', borderWidth: 1.5, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0 }),
    ];
    axis = bandAxis(datasets[0].data, target);
  } else if (currentView === 'listening' || currentView === 'reading') {
    const key = currentView === 'listening' ? 'sections' : 'passages';
    const count = currentView === 'listening' ? 4 : 3;
    const word = currentView === 'listening' ? 'Section' : 'Passage';
    const partDatasets = Array.from({ length: count }, (_, index) => lineDS(word + ' ' + (index + 1), attempts.map(attempt => {
      const parts = attempt[currentView]?.[key];
      return parts && parts[index] != null ? parts[index] : null;
    }), partColors[index], { key: `${currentView === 'listening' ? 'section' : 'passage'}-${index + 1}`, ...patternFor(index) }));
    const average = lineDS('Average', attempts.map(attempt => averageForParts(attempt[currentView]?.[key])), colors.accent, {
      key: 'average',
      borderWidth: 3,
      pointRadius: 4,
      pointHoverRadius: 6,
    });
    datasets = [...partDatasets, average];
    axis = currentView === 'listening'
      ? { min: 0, max: 10, stepSize: 2, title: 'Correct answers', decimals: 0 }
      : { min: 0, max: 20, stepSize: 5, title: 'Correct answers', decimals: 0 };
  } else if (currentView === 'writing') {
    datasets = [
      lineDS('Task 1', attempts.map(attempt => attempt.writing?.task1 ?? null), partColors[0], { key: 'task-1', ...patternFor(0) }),
      lineDS('Task 2', attempts.map(attempt => attempt.writing?.task2 ?? null), partColors[3], { key: 'task-2', ...patternFor(1) }),
      lineDS('Writing band', attempts.map(attempt => attempt.writing?.band ?? null), colors.writing, {
        key: 'writing-band',
        borderWidth: 3,
        ...patternFor(2),
        pointRadius: attempts.map((attempt, index) => attempt.writing?.band == null ? 0 : index === attempts.length - 1 ? 6 : 3.5),
      }),
      lineDS('Target', attempts.map(() => target), colors.ink, { key: 'target', borderWidth: 1.5, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0 }),
    ];
    axis = bandAxis(datasets[2].data, target);
  } else {
    datasets = [
      lineDS('Speaking band', attempts.map(attempt => attempt.speaking?.band ?? null), colors.speaking, {
        key: 'speaking-band',
        borderWidth: 3,
        pointRadius: attempts.map((attempt, index) => attempt.speaking?.band == null ? 0 : index === attempts.length - 1 ? 6 : 3.5),
      }),
      lineDS('Target', attempts.map(() => target), colors.ink, { key: 'target', borderWidth: 1.5, borderDash: [6, 5], pointRadius: 0, pointHoverRadius: 0 }),
    ];
    axis = bandAxis(datasets[0].data, target);
  }
  const latest = latestComparable(attempts, currentView);
  const previous = latest ? previousComparable(attempts, currentView, latest.index) : null;
  const change = latest && previous != null ? roundHalf(latest.value - previous) : null;
  const gap = latest ? roundHalf(target - latest.value) : target;
  return {
    labels,
    datasets,
    axis,
    summary: {
      latest: latest ? fmtBand(latest.value) : 'No result',
      change: formatChange(change),
      gap: latest && gap <= 0 ? 'Target reached' : `${fmtBand(Math.max(0, gap))} band`,
      coverage: `${latest ? coverageFor(latest.attempt) : 0} of 4 skills logged`,
    },
    rows: attempts.map((attempt, index) => ({ attempt, label: labels[index], values: datasets.filter(d => d.label !== 'Target').map(dataset => dataset.data[index]) })),
  };
}

function renderTrendSummary(list) {
  const wrap = document.getElementById('chartSummary');
  if (!wrap) return;
  const latest = latestComparable(list, chartView);
  const previous = latest ? previousComparable(list, chartView, latest.index) : null;
  const target = targetForView(chartView);
  const gap = latest ? roundHalf(target - latest.value) : target;
  const latestAttempt = latest ? latest.attempt : null;
  const change = latest && previous != null ? roundHalf(latest.value - previous) : null;
  const latestText = latest ? fmtBand(latest.value) : 'No result';
  const gapText = latest && gap <= 0 ? 'Target reached' : `${fmtBand(Math.max(0, gap))} band`;
  const gapClass = latest && gap <= 0 ? 'positive' : 'warning';
  const changeClass = change == null ? 'neutral' : change > 0 ? 'positive' : change < 0 ? 'warning' : 'neutral';
  const coverageText = latestAttempt ? `${coverageFor(latestAttempt)} of 4 skills logged` : '0 of 4 skills logged';
  wrap.innerHTML = `
    <div class="trend-stat"><span class="trend-stat-label">Latest</span><strong class="trend-stat-value">${latestText}</strong></div>
    <div class="trend-stat"><span class="trend-stat-label">Change</span><strong class="trend-stat-value ${changeClass}">${formatChange(change)}</strong></div>
    <div class="trend-stat"><span class="trend-stat-label">Target gap</span><strong class="trend-stat-value ${gapClass}">${gapText}</strong></div>
    <div class="trend-stat"><span class="trend-stat-label">Coverage</span><strong class="trend-stat-value neutral">${coverageText}</strong></div>`;
}

function renderChartTabs() {
  const wrap = document.getElementById('chartTabs');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.setAttribute('role', 'tablist');
  wrap.setAttribute('aria-label', 'Choose a trend view');
  const panel = document.getElementById('chartPanel');
  if (panel) {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', 'chart-tab-' + chartView);
  }
  CHART_TABS.forEach(t => {
    const b = document.createElement('button');
    b.className = 'chart-tab' + (chartView === t.key ? ' active' : '');
    b.type = 'button';
    b.setAttribute('id', 'chart-tab-' + t.key);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'chartPanel');
    b.setAttribute('aria-selected', chartView === t.key ? 'true' : 'false');
    b.tabIndex = chartView === t.key ? 0 : -1;
    b.textContent = t.label;
    b.addEventListener('click', () => { chartView = t.key; chartSeries = 'all'; renderChart(); });
    b.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const index = CHART_TABS.findIndex(tab => tab.key === chartView);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? CHART_TABS.length - 1 :
        (index + (e.key === 'ArrowRight' ? 1 : -1) + CHART_TABS.length) % CHART_TABS.length;
      chartView = CHART_TABS[next].key;
      chartSeries = 'all';
      renderChart();
      document.getElementById('chart-tab-' + chartView)?.focus();
    });
    wrap.appendChild(b);
  });
}

function bandBounds(datasets, target) {
  const values = datasets.filter(d => d.label !== 'Target').flatMap(d => d.data).filter(v => v != null);
  if (target != null) values.push(target);
  if (!values.length) return { min: 4, max: 9 };
  let min = Math.max(0, Math.floor((Math.min(...values) - 0.5) * 2) / 2);
  let max = Math.min(9, Math.ceil((Math.max(...values) + 0.5) * 2) / 2);
  if (max - min < 2) {
    min = Math.max(0, min - 0.5);
    max = Math.min(9, max + 0.5);
  }
  return { min, max };
}

function renderChartLegend(datasets) {
  const wrap = document.getElementById('chartLegend');
  if (!wrap) return;
  const measurable = datasets.filter(d => d.label !== 'Target');
  const buttons = [
    `<button type="button" class="chart-series-button${chartSeries === 'all' ? ' active' : ''}" data-series="all" aria-pressed="${chartSeries === 'all'}"><span class="legend-swatch" style="--legend-color:var(--ink-muted)" aria-hidden="true"></span>All</button>`,
    ...measurable.map(d => {
    const pattern = !d.borderDash?.length ? 'solid' : d.borderDash.length > 2 ? 'dash-dot' : d.borderDash[0] <= 3 ? 'dotted' : 'dashed';
    const dash = d.borderDash || [];
    let cursor = 0;
    const stops = dash.map((length, index) => {
      const start = cursor;
      cursor += length;
      return `${index % 2 ? 'transparent' : 'var(--legend-color)'} ${start}px ${cursor}px`;
    }).join(', ');
    const style = `--legend-color:${d.borderColor}${stops ? `;background:repeating-linear-gradient(90deg, ${stops})` : ''}`;
    const patternId = dash.length ? dash.join('-') : 'solid';
    return `<button type="button" class="chart-series-button${chartSeries === d.key ? ' active' : ''}" data-series="${d.key}" aria-pressed="${chartSeries === d.key}"><span class="legend-swatch pattern-${pattern}" data-pattern="${patternId}" style="${style}" aria-hidden="true"></span>${d.label}</button>`;
    }),
  ];
  const target = datasets.find(d => d.label === 'Target');
  const targetLegend = target ? `<span class="legend-item"><span class="legend-swatch pattern-dashed" data-pattern="${target.borderDash?.join('-') || 'solid'}" style="--legend-color:${target.borderColor}" aria-hidden="true"></span>${target.label}</span>` : '';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Choose a chart series');
  wrap.innerHTML = buttons.join('') + targetLegend;
  if (typeof wrap.querySelectorAll === 'function') {
    wrap.querySelectorAll('[data-series]').forEach(button => {
      button.addEventListener('click', () => {
        chartSeries = button.dataset.series || 'all';
        renderChart();
      });
    });
  }
}

function renderChartData(list, datasets, labels, decimals) {
  const table = document.getElementById('chartDataTable');
  const description = document.getElementById('chartDescription');
  if (!table || !description) return;
  const latest = latestComparable(list, chartView);
  const target = targetForView(chartView);
  const currentName = chartView === 'overall' ? 'attempt average' : `${CHART_TABS.find(t => t.key === chartView).label} score`;
  description.textContent = latest
    ? `${currentName} is ${fmtBand(latest.value)} on ${formatDate(latest.attempt.date)}. ${coverageFor(latest.attempt)} of 4 skills logged in the latest attempt. Target: ${fmtBand(target)}.`
    : `No ${currentName} has been logged yet. Target: ${fmtBand(target)}.`;
  const headers = chartView === 'overall' ? ['Attempt', 'Date', 'Label', 'Average', 'Coverage'] :
    ['Attempt', 'Date', 'Label', ...datasets.filter(d => d.label !== 'Target').map(d => d.label)];
  const rows = list.map((attempt, index) => {
    const values = chartView === 'overall'
      ? [fmtBand(overallOf(attempt)), `${coverageFor(attempt)} of 4 logged`]
      : datasets.filter(d => d.label !== 'Target').map(d => {
        const value = d.data[index]; return value == null ? '—' : Number(value).toFixed(decimals);
      });
    return `<tr><td>${labels[index]}</td><td>${formatDate(attempt.date)}</td><td>${escapeHtml(attempt.label || '—')}</td>${values.map(v => `<td>${v}</td>`).join('')}</tr>`;
  }).join('');
  table.innerHTML = `<table><caption>${escapeHtml(currentName)} data</caption><thead><tr>${headers.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderChart() {
  const list = sortedAttempts();
  const empty = document.getElementById('chartEmpty');
  const box = document.getElementById('chartPanel');
  const description = document.getElementById('chartDescription');
  renderChartTabs();
  renderTrendSummary(list);
  if (!empty || !box) return;
  const hasData = list.length > 0;
  empty.style.display = hasData ? 'none' : 'block';
  box.style.display = hasData ? 'block' : 'none';
  if (description && description.classList) description.classList.toggle('sr-only', !hasData);
  if (typeof Chart === 'undefined') return;  // chart library unavailable — summary remains useful
  if (!hasData) {
    document.getElementById('chartLegend').innerHTML = '';
    document.getElementById('chartDescription').textContent = 'Add a test result to plot your progress.';
    document.getElementById('chartDataTable').innerHTML = '';
    if (chart) { chart.destroy(); chart = null; }
    return;
  }

  const model = buildChartModel(list, chartView, state.targets);
  const colors = chartColors();
  const labels = model.labels;
  const allDatasets = model.datasets;
  const datasets = chartDatasetsForSeries(allDatasets, chartSeries);
  const bounds = model.axis;
  const yTitle = bounds.title;
  const yStep = bounds.stepSize;
  const decimals = bounds.decimals;
  renderChartLegend(allDatasets);
  renderChartData(list, datasets, labels, decimals);

  const cfg = {
    type: 'line', data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration() },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: colors.ink, padding: 12, cornerRadius: 10,
          titleFont: { family: 'ui-sans-serif', weight: '600' }, bodyFont: { family: 'ui-sans-serif' },
          callbacks: {
            title: items => {
              const attempt = list[items[0]?.dataIndex];
              return attempt ? `${formatDate(attempt.date)}${attempt.label ? ` · ${attempt.label}` : ''}` : '';
            },
            label: c => c.raw == null ? null : `${c.dataset.label}: ${Number(c.raw).toFixed(decimals)}`,
            afterBody: items => {
              const attempt = list[items[0]?.dataIndex];
              return attempt ? [`Coverage: ${coverageFor(attempt)} of 4 skills`] : [];
            },
          },
        },
      },
      scales: {
        y: { min: bounds.min, max: bounds.max, ticks: { stepSize: yStep, font: { family: 'ui-sans-serif' } },
          grid: { color: colors.grid }, title: { display: true, text: yTitle, font: { family: 'ui-sans-serif' } } },
        x: { grid: { display: false }, ticks: { font: { family: 'ui-sans-serif' }, maxRotation: 0, autoSkip: true, autoSkipPadding: 18 } },
      },
    },
  };

  if (chart) chart.destroy();
  chart = new Chart(document.getElementById('growthChart'), cfg);
}

/* =====================================================================
   FORM HANDLING
   ===================================================================== */
function sumInputs(selector) {
  let total = 0, any = false;
  document.querySelectorAll(selector).forEach(inp => {
    if (inp.value !== '') { total += Number(inp.value) || 0; any = true; }
  });
  return any ? total : null;
}
/* per-field values as an array (empty -> null) for per-part charts */
function readNums(selector) {
  const arr = [];
  document.querySelectorAll(selector).forEach(inp => arr.push(inp.value === '' ? null : Number(inp.value)));
  return arr;
}

function updateLive() {
  const lRaw = sumInputs('.l-sec');
  const rRaw = sumInputs('.r-pas');
  document.getElementById('liveListening').textContent =
    lRaw == null ? '— / 40' : `${lRaw}/40 → ${fmtBand(listeningBand(lRaw))}`;
  document.getElementById('liveReading').textContent =
    rRaw == null ? '— / 40' : `${rRaw}/40 → ${fmtBand(readingBand(rRaw))}`;

  const t1 = document.getElementById('wTask1').value;
  const t2 = document.getElementById('wTask2').value;
  let wBand = null;
  if (t1 !== '' && t2 !== '') wBand = roundHalf((Number(t1) + 2 * Number(t2)) / 3);
  else if (t2 !== '') wBand = Number(t2);
  else if (t1 !== '') wBand = Number(t1);
  document.getElementById('liveWriting').textContent = wBand == null ? '—' : fmtBand(wBand);

  const sVal = document.getElementById('sBand').value;
  document.getElementById('liveSpeaking').textContent = sVal === '' ? '—' : fmtBand(Number(sVal));
}

function collectAttempt() {
  const att = { id: nextAttemptId(), date: document.getElementById('dateInput').value,
                label: document.getElementById('labelInput').value.trim() };

  const lSecs = readNums('.l-sec');
  const lRaw = sumInputs('.l-sec');
  if (lRaw != null) att.listening = { sections: lSecs, raw: lRaw, band: listeningBand(lRaw) };

  const rPas = readNums('.r-pas');
  const rRaw = sumInputs('.r-pas');
  if (rRaw != null) att.reading = { passages: rPas, raw: rRaw, band: readingBand(rRaw) };

  const t1 = document.getElementById('wTask1').value;
  const t2 = document.getElementById('wTask2').value;
  if (t1 !== '' || t2 !== '') {
    let band;
    if (t1 !== '' && t2 !== '') band = roundHalf((Number(t1) + 2 * Number(t2)) / 3);
    else band = Number(t2 !== '' ? t2 : t1);
    att.writing = { task1: t1 === '' ? null : Number(t1), task2: t2 === '' ? null : Number(t2), band };
  }

  const sVal = document.getElementById('sBand').value;
  if (sVal !== '') att.speaking = { band: Number(sVal) };

  return att;
}

function nextAttemptId() {
  const stamp = Date.now();
  attemptSerial = stamp <= lastAttemptTimestamp ? attemptSerial + 1 : 0;
  lastAttemptTimestamp = stamp;
  return 'a' + stamp + (attemptSerial ? '-' + attemptSerial : '');
}

function saveAttempt() {
  const att = collectAttempt();
  if (!att.date) { toast('Please pick a test date.'); return; }
  const hasAny = SKILLS.some(s => att[s.key]);
  if (!hasAny) { toast('Enter at least one skill score.'); return; }

  state.attempts.push(att);
  toast('Result saved ✓');
  save(); render();
  resetForm();
  document.getElementById('charts').scrollIntoView({ behavior: chartScrollBehavior(), block: 'center' });
}

function consolidate() {
  const merged = [];
  const byId = new Map();
  state.attempts.forEach(a => {
    const index = a.id ? byId.get(a.id) : undefined;
    if (index != null) {
      const target = merged[index];
      SKILLS.forEach(s => { if (a[s.key]) target[s.key] = a[s.key]; });
    } else {
      if (a.id) byId.set(a.id, merged.length);
      merged.push(a);
    }
  });
  if (merged.length !== state.attempts.length) { state.attempts = merged; save(); }
}

function deleteAttempt(id) {
  state.attempts = state.attempts.filter(a => a.id !== id);
  save(); render();
  toast('Test deleted');
}

function resetForm() {
  document.querySelectorAll('.l-sec, .r-pas').forEach(i => i.value = '');
  document.getElementById('wTask1').value = '';
  document.getElementById('wTask2').value = '';
  document.getElementById('sBand').value = '';
  document.getElementById('labelInput').value = '';
  document.getElementById('dateInput').value = today();
  updateLive();
}

function today() { return new Date().toISOString().slice(0, 10); }

/* ----- Backup: export / import ----- */
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ielts-progress-' + today() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Backup file downloaded ✓');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || !Array.isArray(data.attempts)) throw new Error('bad');
      state = data;
      if (!state.targets) state.targets = { listening: 7, reading: 7, writing: 6.5, speaking: 6.5 };
      consolidate(); save(); render();
      toast('Backup restored ✓ (' + state.attempts.length + ' tests)');
    } catch (e) {
      toast('That file is not a valid backup.');
    }
  };
  reader.readAsText(file);
}

/* ----- Toast ----- */
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* =====================================================================
   INIT
   ===================================================================== */
function init() {
  // hide app until auth resolves
  document.querySelector('.container').style.display = 'none';
  document.getElementById('authOverlay').hidden = false;
  const bv = document.getElementById('buildVer');
  if (bv) bv.textContent = 'build ' + BUILD;

  // surface any uncaught error on the auth screen instead of failing silently
  const showErr = msg => {
    const el = document.getElementById('authMsg');
    if (el && !document.getElementById('authOverlay').hidden) {
      el.textContent = String(msg).slice(0, 70); el.className = 'auth-msg error';
    }
  };
  window.addEventListener('error', e => showErr('Error: ' + (e.message || '')));
  window.addEventListener('unhandledrejection', e => showErr('Error: ' + ((e.reason && e.reason.message) || e.reason || '')));

  // populate writing/speaking selects (allow empty)
  const emptyOpt = '<option value="">—</option>';
  document.getElementById('wTask1').innerHTML = emptyOpt + bandOptions(null, 4);
  document.getElementById('wTask2').innerHTML = emptyOpt + bandOptions(null, 4);
  document.getElementById('sBand').innerHTML = emptyOpt + bandOptions(null, 4);
  document.getElementById('dateInput').value = today();

  // app events
  document.getElementById('saveBtn').addEventListener('click', saveAttempt);
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('Delete ALL your saved tests and reset goals?')) {
      state = { targets: { ...DEFAULT_TARGETS }, attempts: [] };
      save(); render(); resetForm(); toast('Everything reset');
    }
  });
  document.querySelectorAll('.l-sec, .r-pas, .w-task, .s-band').forEach(el => {
    el.addEventListener('input', updateLive);
    el.addEventListener('change', updateLive);
  });
  document.getElementById('exportBtn').addEventListener('click', exportData);
  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', e => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
  document.querySelectorAll('.l-sec').forEach(i => i.addEventListener('input', () => clamp(i, 0, 10)));
  document.querySelectorAll('.r-pas').forEach(i => i.addEventListener('input', () => clamp(i, 0, 20)));

  // admin / account nav
  document.getElementById('adminBtn').addEventListener('click', openAdmin);
  document.getElementById('adminCloseBtn').addEventListener('click', () => closeAdmin());
  document.getElementById('signOutBtn').addEventListener('click', doSignOut);

  setupAuthUI();
  initCloud();
}

/* =====================================================================
   AUTH + CLOUD
   ===================================================================== */
function initCloud() {
  if (!window.FIREBASE_API_KEY || !window.FIREBASE_PROJECT_ID) {
    showAuth();
    setAuthMsg('Cloud is not configured yet.', 'error');
    return;
  }
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
  if (s && s.uid && s.refreshToken) resumeSession(s);
  else showAuth();
}

function setupAuthUI() {
  let mode = 'login';
  const tabs = document.querySelectorAll('.auth-tab');
  const signupOnly = document.querySelector('.signup-only');
  const submit = document.getElementById('authSubmit');
  const passInput = document.getElementById('auPass');

  function setMode(m) {
    mode = m;
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === m));
    signupOnly.hidden = (m !== 'signup');
    document.getElementById('auFirst').required = (m === 'signup');
    document.getElementById('auLast').required = (m === 'signup');
    submit.textContent = (m === 'signup') ? 'Create account' : 'Sign in';
    passInput.autocomplete = (m === 'signup') ? 'new-password' : 'current-password';
    setAuthMsg('', '');
  }
  tabs.forEach(t => t.addEventListener('click', () => setMode(t.dataset.tab)));

  document.getElementById('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auEmail').value.trim();
    const pass = document.getElementById('auPass').value.trim();
    const first = document.getElementById('auFirst').value.trim();
    const last = document.getElementById('auLast').value.trim();
    if (!email || !pass) { setAuthMsg('Enter your email and password.', 'error'); return; }
    submit.disabled = true;
    let waitSecs = 0;
    setAuthMsg('Please wait… (0s)', '');
    const ticker = setInterval(() => setAuthMsg('Please wait… (' + (++waitSecs) + 's)', ''), 1000);
    const logEl = document.getElementById('authLog'); if (logEl) logEl.textContent = '';
    dlog('--- ' + mode + ' ---');
    try {
      const isSignup = (mode === 'signup');
      let auth;
      if (isSignup) {
        if (!first || !last) { setAuthMsg('Please enter your first and last name.', 'error'); return; }
        try { auth = await fbSignUp(email, pass); }
        catch (err) {
          if (/EMAIL_EXISTS/.test(err.code || err.message)) { setAuthMsg('This email is already registered — use Sign in.', 'error'); setMode('login'); return; }
          throw err;
        }
      } else {
        try { auth = await fbSignIn(email, pass); }
        catch (err) {
          if (/INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD|MISSING_PASSWORD/.test(err.code || err.message)) {
            setAuthMsg('Wrong email or password.', 'error'); return;
          }
          throw err;
        }
      }
      // Auth succeeded — get INTO the app immediately; sync Firestore in the
      // background so a slow/blocked data server never freezes the login.
      dlog('auth ok, opening app');
      setSession(auth);
      currentUser.email = email;
      currentUser.fullName = isSignup ? (first + ' ' + last).trim() : (currentUser.fullName || email.split('@')[0]);
      currentUser.role = currentUser.role || 'student';
      state = normalizeState(loadCache(currentUser.uid));
      saveSession();
      showApp();
      render(); updateLive();
      setAuthMsg('', '');
      dlog('app shown ✓');
      syncProfile(isSignup);
    } catch (err) {
      clearInterval(ticker);
      dlog('STOP: ' + (err.message || err).toString().slice(0, 40));
      setAuthMsg(friendlyAuthError(err), 'error');
    } finally {
      clearInterval(ticker);
      submit.disabled = false;
    }
  });
}

// Create/load the Firestore profile after the app is already showing.
async function syncProfile(isSignup) {
  try {
    if (isSignup) {
      await fsSetUser(currentUser.uid, {
        full_name: currentUser.fullName, email: currentUser.email,
        is_admin: false, data: state, updated_at: new Date().toISOString(),
      });
    } else {
      const prof = await fsGetUser(currentUser.uid);
      if (prof) applyProfile(prof);
      else await fsSetUser(currentUser.uid, {
        full_name: currentUser.fullName, email: currentUser.email,
        is_admin: false, data: state, updated_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    toast('Cloud sync is slow — your data is saved on this device.');
  }
}

function friendlyAuthError(err) {
  const m = err.code || err.message || '';
  if (/EMAIL_EXISTS/.test(m)) return 'This email is already registered — use Sign in.';
  if (/INVALID_LOGIN_CREDENTIALS|EMAIL_NOT_FOUND|INVALID_PASSWORD/.test(m)) return 'Wrong email or password.';
  if (/WEAK_PASSWORD/.test(m)) return 'Password should be at least 6 characters.';
  if (/INVALID_EMAIL/.test(m)) return 'That email address looks invalid.';
  if (/timed out|failed to fetch|networkerror|load failed/i.test(m)) return 'Connection problem — please try again.';
  return m || 'Something went wrong. Please try again.';
}

/* reject if a promise takes too long, so the UI never hangs forever */
function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('Connection timed out. Please check your internet and try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function setAuthMsg(msg, kind) {
  const el = document.getElementById('authMsg');
  el.textContent = msg;
  el.className = 'auth-msg' + (kind ? ' ' + kind : '');
}

function cacheKey(uid) { return STORAGE_KEY + ':' + uid; }
function loadCache(uid) {
  try { const raw = localStorage.getItem(cacheKey(uid)); if (raw) return JSON.parse(raw); } catch (e) {}
  return null;
}

function setSession(auth) {
  currentUser = currentUser || {};
  currentUser.uid = auth.localId || auth.uid;
  currentUser.idToken = auth.idToken;
  currentUser.refreshToken = auth.refreshToken;
  currentUser.expiresAt = Date.now() + (+auth.expiresIn || 3600) * 1000;
  saveSession();
}

function saveSession() {
  if (!currentUser) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      uid: currentUser.uid, refreshToken: currentUser.refreshToken,
      idToken: currentUser.idToken, expiresAt: currentUser.expiresAt,
      fullName: currentUser.fullName, email: currentUser.email, role: currentUser.role,
    }));
  } catch (e) {}
}

function unionAttempts(cloudArr, localArr) {
  const out = (cloudArr || []).map(a => ({ ...a }));
  const idx = new Map();
  out.forEach((attempt, index) => {
    if (attempt.id) idx.set(attempt.id, index);
  });
  (localArr || []).forEach(a => {
    if (a.id && idx.has(a.id)) {
      const t = out[idx.get(a.id)];
      SKILLS.forEach(s => { if (a[s.key]) t[s.key] = a[s.key]; });
    } else {
      out.push({ ...a });
      if (a.id) idx.set(a.id, out.length - 1);
    }
  });
  return out;
}

function applyProfile(prof) {
  currentUser.fullName = prof.full_name || currentUser.fullName || '';
  currentUser.email = prof.email || currentUser.email || '';
  currentUser.role = prof.is_admin ? 'admin' : 'student';
  saveSession();
  if (prof.data && (prof.data.attempts || prof.data.targets)) {
    const cloud = normalizeState(prof.data);
    const merged = unionAttempts(cloud.attempts, state.attempts);
    const grewLocally = merged.length !== cloud.attempts.length;
    state = { targets: cloud.targets, attempts: merged };
    consolidate();
    if (grewLocally) save();   // push results added during the sync window back to the cloud
  }
  refreshTopbar();
  render(); updateLive();
}

// Resume a saved login: show app instantly from cache, verify in background
async function resumeSession(s) {
  currentUser = {
    uid: s.uid, refreshToken: s.refreshToken, idToken: s.idToken, expiresAt: s.expiresAt || 0,
    fullName: s.fullName || '', email: s.email || '', role: s.role || 'student',
  };
  state = normalizeState(loadCache(s.uid));
  showApp();
  render(); updateLive();
  try {
    const prof = await fsGetUser(s.uid);
    if (prof) applyProfile(prof);
  } catch (e) {
    if (/INVALID_REFRESH_TOKEN|TOKEN_EXPIRED|USER_NOT_FOUND|INVALID_GRANT/i.test(e.message || '')) doSignOut();
    else toast('Slow connection — showing your saved data.');
  }
}

function doSignOut() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  state = { targets: { ...DEFAULT_TARGETS }, attempts: [] };
  currentUser = null;
  resetForm();
  showAuth();
}

function showApp() {
  document.getElementById('authOverlay').hidden = true;
  document.querySelector('.container').style.display = '';
  closeAdmin(true);
  refreshTopbar();
}

function refreshTopbar() {
  if (!currentUser) return;
  const name = (currentUser.fullName || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = (((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '')) || ((currentUser.email || '?')[0]);
  document.getElementById('avatar').textContent = initials.toUpperCase();
  document.getElementById('userName').textContent = name || currentUser.email;
  document.getElementById('signOutBtn').hidden = false;
  document.getElementById('adminBtn').hidden = (currentUser.role !== 'admin');
}

function showAuth() {
  document.getElementById('authOverlay').hidden = false;
  document.querySelector('.container').style.display = 'none';
  document.getElementById('signOutBtn').hidden = true;
  document.getElementById('adminBtn').hidden = true;
  document.getElementById('userName').textContent = '';
  document.getElementById('avatar').textContent = '?';
}

/* =====================================================================
   ADMIN VIEW
   ===================================================================== */
let adminChart = null;

async function openAdmin() {
  if (!currentUser || currentUser.role !== 'admin') return;
  toast('Loading students…');
  let rows;
  try { rows = await fsListUsers(); }
  catch (e) { toast('Could not load students: ' + friendlyAuthError(e)); return; }
  renderAdminList(rows || []);
  document.querySelector('.container > .page-head').style.display = 'none';
  document.querySelector('.layout').style.display = 'none';
  document.getElementById('adminPanel').hidden = false;
  document.getElementById('adminDetailCard').hidden = true;
  window.scrollTo(0, 0);
}

function closeAdmin(silent) {
  document.getElementById('adminPanel').hidden = true;
  const ph = document.querySelector('.container > .page-head');
  const ly = document.querySelector('.layout');
  if (ph) ph.style.display = '';
  if (ly) ly.style.display = '';
  if (!silent) window.scrollTo(0, 0);
}

function attemptsAsc(atts) { return [...atts].sort((a, b) => (a.date || '').localeCompare(b.date || '')); }
function lastBandOf(atts, key) {
  const l = attemptsAsc(atts).filter(a => a[key] && a[key].band != null);
  return l.length ? l[l.length - 1][key].band : null;
}
function lastOverall(atts) {
  const l = attemptsAsc(atts).map(overallOf).filter(v => v != null);
  return l.length ? l[l.length - 1] : null;
}

function renderAdminList(rows) {
  const students = rows.filter(r => !r.is_admin);
  document.getElementById('adminCount').textContent = students.length + (students.length === 1 ? ' student' : ' students');
  const body = document.getElementById('adminBody');
  document.getElementById('adminEmpty').hidden = students.length > 0;
  body.innerHTML = '';
  students.forEach(r => {
    const data = normalizeState(r.data);
    const atts = data.attempts;
    const t = data.targets;
    const tgt = roundHalf((t.listening + t.reading + t.writing + t.speaking) / 4);
    const tr = document.createElement('tr');
    tr.className = 'admin-row';
    tr.innerHTML = `
      <td>${escapeHtml((r.full_name || '').trim()) || '—'}</td>
      <td class="muted">${escapeHtml(r.email || '')}</td>
      <td>${fmtBand(lastBandOf(atts, 'listening'))}</td>
      <td>${fmtBand(lastBandOf(atts, 'reading'))}</td>
      <td>${fmtBand(lastBandOf(atts, 'writing'))}</td>
      <td>${fmtBand(lastBandOf(atts, 'speaking'))}</td>
      <td class="band-overall">${fmtBand(lastOverall(atts))}</td>
      <td>${fmtBand(tgt)}</td>
      <td>${atts.length}</td>
      <td class="muted">${r.updated_at ? formatDate(r.updated_at.slice(0, 10)) : '—'}</td>`;
    tr.addEventListener('click', () => openStudentDetail(r));
    body.appendChild(tr);
  });
}

function openStudentDetail(r) {
  const data = normalizeState(r.data);
  const atts = attemptsAsc(data.attempts);
  document.getElementById('adminDetailName').textContent =
    (r.full_name || '').trim() || r.email;

  const cards = SKILLS.map(s =>
    `<div class="admin-band-card"><div class="lbl">${s.name}</div><div class="val">${fmtBand(lastBandOf(atts, s.key))}</div></div>`).join('')
    + `<div class="admin-band-card overall"><div class="lbl">Overall</div><div class="val">${fmtBand(lastOverall(atts))}</div></div>`;
  document.getElementById('adminDetailBands').innerHTML = cards;

  const hist = document.getElementById('adminDetailHistory');
  hist.innerHTML = '';
  [...atts].reverse().forEach(a => {
    const c = key => a[key] && a[key].band != null ? fmtBand(a[key].band) : '<span class="muted">—</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${formatDate(a.date)}</td><td class="muted">${escapeHtml(a.label || '—')}</td>` +
      `<td>${c('listening')}</td><td>${c('reading')}</td><td>${c('writing')}</td><td>${c('speaking')}</td>` +
      `<td class="band-overall">${fmtBand(overallOf(a))}</td>`;
    hist.appendChild(tr);
  });

  drawAdminChart(atts);
  document.getElementById('adminDetailCard').hidden = false;
  document.getElementById('adminDetailCard').scrollIntoView({ behavior: chartScrollBehavior(), block: 'start' });
}

function drawAdminChart(atts) {
  if (typeof Chart === 'undefined') return;
  const labels = atts.map(a => a.label ? a.label : formatDate(a.date));
  const colors = chartColors();
  const partColors = [colors.listening, colors.reading, colors.writing, colors.speaking];
  const ds = SKILLS.map((s, index) => ({
    label: s.name, data: atts.map(a => a[s.key]?.band ?? null),
    borderColor: partColors[index], backgroundColor: partColors[index],
    tension: .2, spanGaps: true, borderWidth: 2.5, pointRadius: 3, ...patternFor(index),
  }));
  ds.push({
    label: 'Overall', data: atts.map(overallOf),
    borderColor: colors.ink, backgroundColor: colors.ink,
    borderWidth: 3, borderDash: [6, 4], tension: .2, spanGaps: true, pointRadius: 3,
  });
  const bounds = bandBounds(ds, null);
  const cfg = {
    type: 'line', data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: chartAnimationDuration() },
      plugins: { legend: { display: true, labels: { font: { family: 'ui-sans-serif' }, usePointStyle: true } } },
      scales: {
        y: { min: bounds.min, max: bounds.max, ticks: { stepSize: 0.5, font: { family: 'ui-sans-serif' } }, grid: { color: colors.grid } },
        x: { grid: { display: false }, ticks: { font: { family: 'ui-sans-serif' } } },
      },
    },
  };
  if (adminChart) { adminChart.data = cfg.data; adminChart.options = cfg.options; adminChart.update(); }
  else adminChart = new Chart(document.getElementById('adminChart'), cfg);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function clamp(input, lo, hi) {
  if (input.value === '') return;
  let v = Number(input.value);
  if (v < lo) input.value = lo;
  if (v > hi) input.value = hi;
}

document.addEventListener('DOMContentLoaded', init);
