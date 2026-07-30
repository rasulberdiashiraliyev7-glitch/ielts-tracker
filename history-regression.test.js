const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8')
  .replace(/document\.addEventListener\('DOMContentLoaded', init\);\s*$/, '') + `
globalThis.__history = {
  getState: () => state,
  setState: next => { state = next; },
  consolidate,
  unionAttempts,
  saveAttempt,
  setTestHooks: hooks => {
    save = hooks.save;
    render = hooks.render;
    resetForm = hooks.resetForm;
    toast = hooks.toast;
  },
};
`;

const fields = {
  charts: { scrollIntoView: () => {} },
  dateInput: { value: '2026-07-30' },
  labelInput: { value: '' },
  wTask1: { value: '' },
  wTask2: { value: '' },
  sBand: { value: '6.5' },
};
const context = vm.createContext({
  console,
  Date,
  setTimeout,
  clearTimeout,
  document: {
    getElementById: id => fields[id],
    querySelectorAll: () => [],
  },
  window: {},
  globalThis: {},
});
context.globalThis = context;
vm.runInContext(source, context, { filename: 'app.js' });
const history = context.__history;

function freshState(attempts = []) {
  history.setState({ targets: { listening: 7, reading: 7, writing: 6.5, speaking: 6.5 }, attempts });
}

function testSaveAttemptAppendsSameDayBlankLabel() {
  let nextId = 1;
  context.Date = { now: () => nextId++ };
  history.setTestHooks({ save: () => {}, render: () => {}, resetForm: () => {}, toast: () => {} });
  freshState();
  history.saveAttempt();
  history.saveAttempt();
  assert.deepEqual(history.getState().attempts.map(attempt => attempt.id), ['a1', 'a2']);
}

function testConsolidatePreservesSameDayAttempts() {
  freshState([
    { id: 'a1', date: '2026-07-30', label: '' },
    { id: 'a2', date: '2026-07-30', label: '' },
  ]);
  history.consolidate();
  assert.deepEqual(history.getState().attempts.map(attempt => attempt.id), ['a1', 'a2']);
}

function testUnionDedupesOnlySameAttemptId() {
  const cloud = [{ id: 'a1', date: '2026-07-30', label: '', speaking: { band: 6 } }];
  const local = [
    { id: 'a1', date: '2026-07-30', label: '', speaking: { band: 6.5 } },
    { id: 'a2', date: '2026-07-30', label: '', speaking: { band: 7 } },
  ];
  const merged = history.unionAttempts(cloud, local);
  assert.deepEqual(merged.map(attempt => attempt.id), ['a1', 'a2']);
  assert.equal(merged[0].speaking.band, 6.5);
}

testSaveAttemptAppendsSameDayBlankLabel();
testConsolidatePreservesSameDayAttempts();
testUnionDedupesOnlySameAttemptId();
console.log('PASS same-day history regression: save, local consolidation, and cloud union preserve distinct IDs');
