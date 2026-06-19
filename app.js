/* =====================================================================
   IELTS Progress Tracker — vanilla JS, data persisted in localStorage
   ===================================================================== */

const STORAGE_KEY = 'ielts_tracker_v1';
const BUILD = '7';

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

/* ---------- Cloud / auth globals ---------- */
let currentUser = null;   // { id, fullName, login, role, pin }
let cloudTimer = null;
const SESSION_KEY = 'ielts_session_v1';

function normalizeState(data) {
  const s = (data && typeof data === 'object') ? data : {};
  if (!s.targets) s.targets = { ...DEFAULT_TARGETS };
  if (!Array.isArray(s.attempts)) s.attempts = [];
  return s;
}

/* Direct REST call to a Postgres function — plain fetch, no supabase-js,
   so there is no auth lock that can deadlock and freeze the UI. */
async function rpc(fn, args) {
  const res = await withTimeout(fetch(window.SUPABASE_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      apikey: window.SUPABASE_KEY,
      Authorization: 'Bearer ' + window.SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  }), 12000);
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || msg; } catch (e) {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return text ? JSON.parse(text) : null;
}

/* save = local cache (per user) + debounced cloud save */
function save() {
  if (currentUser) {
    try { localStorage.setItem(STORAGE_KEY + ':' + currentUser.id, JSON.stringify(state)); } catch (e) {}
    scheduleCloudSave();
  }
}
function scheduleCloudSave() {
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(cloudSaveNow, 800);
}
async function cloudSaveNow() {
  if (!currentUser) return;
  try { await rpc('app_save', { p_id: currentUser.id, p_pin: currentUser.pin, p_data: state }); }
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
  else if (toGo === 0) { el.textContent = 'Goal reached! 🎉'; el.classList.remove('accent'); }
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
    title.textContent = 'Goal smashed! 🎉';
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
  const list = sortedAttempts().reverse();
  body.innerHTML = '';
  empty.style.display = list.length ? 'none' : 'block';

  list.forEach(att => {
    const tr = document.createElement('tr');
    const cell = key => att[key]?.band != null ? fmtBand(att[key].band) : '<span class="muted">—</span>';
    tr.innerHTML = `
      <td>${formatDate(att.date)}</td>
      <td class="muted">${att.label || '—'}</td>
      <td class="band-cell">${cell('listening')}</td>
      <td class="band-cell">${cell('reading')}</td>
      <td class="band-cell">${cell('writing')}</td>
      <td class="band-cell">${cell('speaking')}</td>
      <td class="band-overall">${fmtBand(overallOf(att))}</td>
      <td><button class="del-btn" data-id="${att.id}" title="Delete">✕</button></td>`;
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

/* ----- Growth chart ----- */
function renderChart() {
  const list = sortedAttempts();
  const empty = document.getElementById('chartEmpty');
  const box = document.querySelector('.chart-box');
  const hasData = list.length > 0;
  empty.style.display = hasData ? 'none' : 'block';
  box.style.display = hasData ? 'block' : 'none';

  // legend
  const legend = document.getElementById('chartLegend');
  legend.innerHTML = [...SKILLS, { name: 'Overall', color: '#14293b' }]
    .map(s => `<span class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.name}</span>`).join('');

  if (!hasData) { if (chart) { chart.destroy(); chart = null; } return; }

  const labels = list.map((a, i) => a.label ? a.label : formatDate(a.date));
  const datasets = SKILLS.map(s => ({
    label: s.name,
    data: list.map(a => a[s.key]?.band ?? null),
    borderColor: s.color,
    backgroundColor: s.color,
    tension: 0.35, spanGaps: true, borderWidth: 2.5,
    pointRadius: 4, pointHoverRadius: 6,
  }));
  datasets.push({
    label: 'Overall',
    data: list.map(overallOf),
    borderColor: '#14293b', backgroundColor: '#14293b',
    borderWidth: 3, borderDash: [6, 4], tension: 0.35, spanGaps: true,
    pointRadius: 4, pointHoverRadius: 6,
  });

  // target reference lines
  const targetLines = SKILLS.map(s => ({
    label: s.name + ' target',
    data: list.map(() => state.targets[s.key]),
    borderColor: s.color, borderWidth: 1, borderDash: [2, 3],
    pointRadius: 0, tension: 0, hidden: true,
  }));

  const cfg = {
    type: 'line',
    data: { labels, datasets: [...datasets, ...targetLines] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#14293b', padding: 12, cornerRadius: 10,
          titleFont: { family: 'Poppins', weight: '600' },
          bodyFont: { family: 'Poppins' },
          callbacks: { label: c => c.raw == null ? null : `${c.dataset.label}: ${Number(c.raw).toFixed(1)}` },
        },
      },
      scales: {
        y: {
          min: 4, max: 9, ticks: { stepSize: 0.5, font: { family: 'Poppins' } },
          grid: { color: '#eef2f3' }, title: { display: true, text: 'Band score', font: { family: 'Poppins' } },
        },
        x: { grid: { display: false }, ticks: { font: { family: 'Poppins' }, maxRotation: 0, autoSkip: true } },
      },
    },
  };

  if (chart) { chart.data = cfg.data; chart.options = cfg.options; chart.update(); }
  else chart = new Chart(document.getElementById('growthChart'), cfg);
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
  const att = { id: 'a' + Date.now(), date: document.getElementById('dateInput').value,
                label: document.getElementById('labelInput').value.trim() };

  const lRaw = sumInputs('.l-sec');
  if (lRaw != null) att.listening = { raw: lRaw, band: listeningBand(lRaw) };

  const rRaw = sumInputs('.r-pas');
  if (rRaw != null) att.reading = { raw: rRaw, band: readingBand(rRaw) };

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

function saveAttempt() {
  const att = collectAttempt();
  if (!att.date) { toast('Please pick a test date.'); return; }
  const hasAny = SKILLS.some(s => att[s.key]);
  if (!hasAny) { toast('Enter at least one skill score.'); return; }

  // merge into an existing test with the same date + label, instead of a new row
  const existing = state.attempts.find(a => sameTest(a, att));
  if (existing) {
    SKILLS.forEach(s => { if (att[s.key]) existing[s.key] = att[s.key]; });
    toast('Added to that day\'s test ✓');
  } else {
    state.attempts.push(att);
    toast('Result saved ✓');
  }
  save(); render();
  resetForm();
  document.getElementById('charts').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* two entries are the same test if they share a date and label */
function sameTest(a, b) {
  return (a.date || '') === (b.date || '') && (a.label || '') === (b.label || '');
}

/* one-time consolidation: merge older split rows that share date + label */
function consolidate() {
  const merged = [];
  state.attempts.forEach(a => {
    const target = merged.find(m => sameTest(m, a));
    if (target) {
      SKILLS.forEach(s => { if (a[s.key]) target[s.key] = a[s.key]; });
    } else {
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
  if (!window.SUPABASE_URL || !window.SUPABASE_KEY) {
    showAuth();
    setAuthMsg('Cloud is not configured yet.', 'error');
    return;
  }
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) {}
  if (s && s.id && s.pin) resumeSession(s);
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
    setAuthMsg('Please wait…', '');
    try {
      let prof;
      if (mode === 'signup') {
        if (!first || !last) { setAuthMsg('Please enter your first and last name.', 'error'); return; }
        try {
          await rpc('app_signup', { p_name: (first + ' ' + last).trim(), p_login: email, p_pin: pass });
        } catch (err) {
          if (err.status === 409 || /duplicate|already|unique/i.test(err.message)) {
            setAuthMsg('This email is already registered — use Sign in.', 'error'); setMode('login'); return;
          }
          throw err;
        }
        const rows = await rpc('app_login', { p_login: email, p_pin: pass });
        prof = rows && rows[0];
      } else {
        const rows = await rpc('app_login', { p_login: email, p_pin: pass });
        if (!rows || !rows.length) { setAuthMsg('Wrong email or password.', 'error'); return; }
        prof = rows[0];
      }
      if (prof) {
        currentUser = {
          id: prof.id, fullName: prof.full_name, login: prof.login,
          role: prof.is_admin ? 'admin' : 'student', pin: pass,
        };
        saveSession();
        state = normalizeState(prof.data);
        consolidate();
        showApp();
        render(); updateLive();
        setAuthMsg('', '');
      }
    } catch (err) {
      setAuthMsg(err.message || 'Connection timed out. Please try again.', 'error');
    } finally {
      submit.disabled = false;
    }
  });
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

function saveSession() {
  if (!currentUser) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      id: currentUser.id, login: currentUser.login, pin: currentUser.pin,
      fullName: currentUser.fullName, role: currentUser.role,
    }));
  } catch (e) {}
}

function applyProfile(prof) {
  currentUser.fullName = prof.full_name || currentUser.fullName;
  currentUser.login = prof.login || currentUser.login;
  currentUser.role = prof.is_admin ? 'admin' : 'student';
  saveSession();
  if (prof.data && (prof.data.attempts || prof.data.targets)) {
    state = normalizeState(prof.data);
    consolidate();
  }
  refreshTopbar();
  render(); updateLive();
}

// Resume a saved login: show app instantly from cache, verify in background
async function resumeSession(s) {
  currentUser = {
    id: s.id, fullName: s.fullName || '', login: s.login || '',
    role: s.role || 'student', pin: s.pin,
  };
  state = normalizeState(loadCache(s.id));
  showApp();
  render(); updateLive();
  try {
    const rows = await rpc('app_login', { p_login: s.login, p_pin: s.pin });
    if (rows && rows.length) applyProfile(rows[0]);
    else doSignOut();
  } catch (e) {
    toast('Slow connection — showing your saved data.');
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
  const initials = (((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || '')) || (currentUser.login[0] || '?');
  document.getElementById('avatar').textContent = initials.toUpperCase();
  document.getElementById('userName').textContent = name || currentUser.login;
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
  try { rows = await rpc('app_admin_list', { p_admin_id: currentUser.id, p_admin_pin: currentUser.pin }); }
  catch (e) { toast('Could not load students: ' + e.message); return; }
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
      <td class="muted">${escapeHtml(r.login || '')}</td>
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
    (r.full_name || '').trim() || r.login;

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
  document.getElementById('adminDetailCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function drawAdminChart(atts) {
  const labels = atts.map(a => a.label ? a.label : formatDate(a.date));
  const ds = SKILLS.map(s => ({
    label: s.name, data: atts.map(a => a[s.key]?.band ?? null),
    borderColor: s.color, backgroundColor: s.color,
    tension: .35, spanGaps: true, borderWidth: 2.5, pointRadius: 3,
  }));
  ds.push({
    label: 'Overall', data: atts.map(overallOf),
    borderColor: '#14293b', backgroundColor: '#14293b',
    borderWidth: 3, borderDash: [6, 4], tension: .35, spanGaps: true, pointRadius: 3,
  });
  const cfg = {
    type: 'line', data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { font: { family: 'Poppins' }, usePointStyle: true } } },
      scales: {
        y: { min: 4, max: 9, ticks: { stepSize: 0.5, font: { family: 'Poppins' } }, grid: { color: '#eef2f3' } },
        x: { grid: { display: false }, ticks: { font: { family: 'Poppins' } } },
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
