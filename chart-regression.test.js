const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('app.js', 'utf8')
  .replace(/document\.addEventListener\('DOMContentLoaded', init\);[\s\S]*$/, '') + `
globalThis.__chartTest = {
  buildChartModel,
  chartDatasetsForSeries,
  chartColors,
  bandAxis,
  chartScrollBehavior,
  chartAnimationDuration,
  renderChartLegend,
  renderChartTabs,
  renderTrendSummary,
  renderChart,
  setView: view => { chartView = view; },
  setSeries: series => { chartSeries = series; },
  setState: next => { state = next; },
};
`;

function node(tagName) {
  return {
    tagName,
    attributes: {},
    children: [],
    className: '',
    innerHTML: '',
    textContent: '',
    tabIndex: 0,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    appendChild(child) { this.children.push(child); },
  addEventListener() {},
    querySelectorAll() { return []; },
    focus() {},
    style: {},
    classList: { toggle() {} },
  };
}

const fields = {
  chartTabs: node('div'),
  chartPanel: node('div'),
  chartSummary: node('div'),
  chartLegend: node('div'),
  chartDescription: node('p'),
  chartDataTable: node('div'),
  chartEmpty: node('p'),
  growthChart: node('canvas'),
};
const context = vm.createContext({
  console,
  Date,
  setTimeout,
  clearTimeout,
  document: {
    getElementById: id => fields[id],
    createElement: tagName => node(tagName),
    querySelectorAll: () => [],
  },
  window: { matchMedia: () => ({ matches: false }) },
});
context.globalThis = context;
vm.runInContext(source, context, { filename: 'app.js' });
const chart = context.__chartTest;
const targets = { listening: 7, reading: 7, writing: 6.5, speaking: 6.5 };

function testSameDayLabelsAndCoverageUseLatestComparableAttempt() {
  const attempts = [
    { date: '2026-07-30', listening: { band: 6.5 }, reading: { band: 6.5 }, writing: { band: 6.5 }, speaking: { band: 6.5 } },
    { date: '2026-07-30', listening: { band: 7 } },
  ];
  const model = chart.buildChartModel(attempts, 'speaking', targets);
  assert.deepEqual(model.labels, ['Jul 30 · #1', 'Jul 30 · #2']);
  assert.equal(model.summary.latest, '6.5');
  assert.equal(model.summary.coverage, '4 of 4 skills logged');

  chart.setView('speaking');
  chart.setState({ targets, attempts });
  chart.renderTrendSummary(attempts);
  assert.match(fields.chartSummary.innerHTML, /4 of 4 skills logged/);
}

function testMissingValuesKeepEverySeriesConnected() {
  const model = chart.buildChartModel([
    { date: '2026-07-28', speaking: { band: 6 } },
    { date: '2026-07-29' },
    { date: '2026-07-30', speaking: { band: 7 } },
  ], 'speaking', targets);
  assert.deepEqual(model.datasets[0].data, [6, null, 7]);
  assert.ok(model.datasets.every(dataset => dataset.spanGaps === true));
}

function testBandAndRawScaleBoundsIncludeAllValidValues() {
  const lowBand = chart.bandAxis([3.5, 4], 7);
  assert.ok(lowBand.min <= 3.5);
  assert.ok(lowBand.max >= 7);

  const reading = chart.buildChartModel([
    { date: '2026-07-30', reading: { passages: [20, 19, 18], band: 8 } },
  ], 'reading', targets);
  assert.equal(reading.axis.max, 20);
  assert.ok(reading.datasets.some(dataset => dataset.data.includes(20)));
}

function testPartViewsUseOneHorizontalAverageAcrossLoggedValues() {
  const listening = chart.buildChartModel([
    { date: '2026-07-28', listening: { sections: [4, 6, 8, 10] } },
    { date: '2026-07-29', listening: { sections: [6, 8, null, 10] } },
  ], 'listening', targets);
  assert.deepEqual(Array.from(listening.datasets, dataset => dataset.key), ['section-1', 'section-2', 'section-3', 'section-4', 'average']);
  assert.deepEqual(Array.from(listening.datasets.find(dataset => dataset.key === 'average').data), [7.4, 7.4]);

  const reading = chart.buildChartModel([
    { date: '2026-07-28', reading: { passages: [18, 20, 22] } },
    { date: '2026-07-29', reading: { passages: [19, null, 21] } },
  ], 'reading', targets);
  assert.deepEqual(Array.from(reading.datasets.find(dataset => dataset.key === 'average').data), [20, 20]);
}

function testPartSelectionRecalculatesTheHorizontalAverageForThatPart() {
  const listening = chart.buildChartModel([
    { date: '2026-07-28', listening: { sections: [4, 6, 8, 10] } },
    { date: '2026-07-29', listening: { sections: [6, 8, null, 10] } },
  ], 'listening', targets);
  const section1 = chart.chartDatasetsForSeries(listening.datasets, 'section-1');
  assert.deepEqual(Array.from(section1, dataset => dataset.key), ['section-1', 'average']);
  assert.deepEqual(Array.from(section1.find(dataset => dataset.key === 'average').data), [5, 5]);
  const section3 = chart.chartDatasetsForSeries(listening.datasets, 'section-3');
  assert.deepEqual(Array.from(section3.find(dataset => dataset.key === 'average').data), [8, 8]);

  const reading = chart.buildChartModel([
    { date: '2026-07-28', reading: { passages: [18, 20, 22] } },
    { date: '2026-07-29', reading: { passages: [19, null, 21] } },
  ], 'reading', targets);
  const passage2 = chart.chartDatasetsForSeries(reading.datasets, 'passage-2');
  assert.deepEqual(Array.from(passage2, dataset => dataset.key), ['passage-2', 'average']);
  assert.deepEqual(Array.from(passage2.find(dataset => dataset.key === 'average').data), [20, 20]);
}

function testAverageReferenceIsVisuallyDistinctFromTheMainSeries() {
  const model = chart.buildChartModel([
    { date: '2026-07-28', listening: { sections: [4, 6, 8, 10] } },
    { date: '2026-07-29', listening: { sections: [6, 8, null, 10] } },
  ], 'listening', targets);
  const selected = chart.chartDatasetsForSeries(model.datasets, 'section-1');
  const main = selected.find(dataset => dataset.key === 'section-1');
  const average = selected.find(dataset => dataset.key === 'average');
  assert.notEqual(average.borderColor, main.borderColor);
  assert.ok(average.borderDash.length > 0);
  assert.equal(average.pointRadius, 0);
  assert.equal(average.pointHoverRadius, 0);
  assert.equal(average.tension, 0);
  assert.ok(average.order > (main.order ?? 0));
}

function testAverageReferenceUsesOneDecimalInTableAndTooltip() {
  context.Chart = function Chart(_canvas, config) { context.__capturedChart = config; this.destroy = () => {}; };
  chart.setView('listening');
  chart.setSeries('all');
  chart.setState({
    targets,
    attempts: [
      { date: '2026-07-28', listening: { sections: [4, 6, 8, 10] } },
      { date: '2026-07-29', listening: { sections: [6, 8, null, 10] } },
    ],
  });
  chart.renderChart();
  const average = context.__capturedChart.data.datasets.find(dataset => dataset.key === 'average');
  const tooltipLabel = context.__capturedChart.options.plugins.tooltip.callbacks.label;
  assert.match(fields.chartDataTable.innerHTML, /<th scope="col">Average<\/th>/);
  assert.equal((fields.chartDataTable.innerHTML.match(/<td>7\.4<\/td>/g) || []).length, 2);
  assert.equal(tooltipLabel({ raw: 7.4, dataset: average }), 'Average: 7.4');
  fields.chartTabs.children = [];
}

function testTabsUseTabpanelSemanticsAndActiveLabel() {
  chart.setView('reading');
  chart.renderChartTabs();
  assert.equal(fields.chartTabs.attributes.role, 'tablist');
  const active = fields.chartTabs.children.find(button => button.attributes['aria-selected'] === 'true');
  assert.equal(active.textContent, 'Reading');
  assert.equal(active.attributes.role, 'tab');
  assert.equal(active.attributes['aria-controls'], 'chartPanel');
  assert.equal(fields.chartPanel.attributes.role, 'tabpanel');
  assert.equal(fields.chartPanel.attributes['aria-labelledby'], active.attributes.id);
}

function testReducedMotionDisablesChartAnimation() {
  context.window.matchMedia = () => ({ matches: true });
  assert.equal(chart.chartScrollBehavior(), 'auto');
  assert.equal(chart.chartAnimationDuration(), 0);
  context.Chart = function Chart(_canvas, config) { context.__capturedChart = config; this.destroy = () => {}; };
  chart.setView('overall');
  chart.setState({ targets, attempts: [{ date: '2026-07-30', speaking: { band: 6.5 } }] });
  chart.renderChart();
  assert.equal(context.__capturedChart.options.animation.duration, 0);
  context.window.matchMedia = () => ({ matches: false });
  assert.equal(chart.chartScrollBehavior(), 'smooth');
  assert.ok(chart.chartAnimationDuration() > 0);
}

function testOverlappingSeriesHavePatternAndLegendEncodings() {
  const model = chart.buildChartModel([
    { date: '2026-07-30', writing: { task1: 6, task2: 6, band: 6 } },
  ], 'writing', targets);
  const patterns = model.datasets.map(dataset => JSON.stringify(dataset.borderDash || []));
  assert.equal(new Set(patterns).size, model.datasets.length);
  chart.renderChartLegend(model.datasets);
  assert.equal((fields.chartLegend.innerHTML.match(/data-pattern=/g) || []).length, model.datasets.length);
  assert.equal(new Set([...fields.chartLegend.innerHTML.matchAll(/data-pattern="([^"]+)"/g)].map(match => match[1])).size, model.datasets.length);
  assert.match(fields.chartLegend.innerHTML, /pattern-dotted/);
}

function testSeriesSelectionKeepsAverageContext() {
  const model = chart.buildChartModel([
    { date: '2026-07-30', listening: { sections: [8, 6, 7, 9], band: 7 } },
  ], 'listening', targets);
  const selected = chart.chartDatasetsForSeries(model.datasets, 'section-3');
  assert.deepEqual(Array.from(selected, dataset => dataset.key), ['section-3', 'average']);
  assert.equal(chart.chartDatasetsForSeries(model.datasets, 'missing').length, model.datasets.length);

  chart.setSeries('section-3');
  chart.renderChartLegend(model.datasets);
  assert.match(fields.chartLegend.innerHTML, /Section 1/);
  assert.match(fields.chartLegend.innerHTML, /Section 3/);
  assert.match(fields.chartLegend.innerHTML, /Section 4/);
  assert.match(fields.chartLegend.innerHTML, /Average/);
  assert.match(fields.chartLegend.innerHTML, /data-series="section-3"[^>]*aria-pressed="true"/);

  const writing = chart.buildChartModel([
    { date: '2026-07-30', writing: { task1: 6, task2: 6.5, band: 6.5 } },
  ], 'writing', targets);
  const writingSelected = chart.chartDatasetsForSeries(writing.datasets, 'task-2');
  assert.deepEqual(Array.from(writingSelected, dataset => dataset.key), ['task-2', 'target']);
  chart.setSeries('all');
}

function testCapturedChartConfigUsesModelBoundsAndPatterns() {
  context.window.matchMedia = () => ({ matches: false });
  chart.setView('reading');
  chart.setState({ targets, attempts: [{ date: '2026-07-30', reading: { passages: [20, 19, 18], band: 8 } }] });
  chart.renderChart();
  assert.equal(context.__capturedChart.options.scales.y.max, 20);
  assert.ok(context.__capturedChart.data.datasets.some(dataset => dataset.data.includes(20)));
  assert.ok(context.__capturedChart.data.datasets.every(dataset => dataset.spanGaps === true));

  chart.setView('writing');
  chart.setState({ targets, attempts: [{ date: '2026-07-30', writing: { task1: 3.5, task2: 4, band: 3.5 } }] });
  chart.renderChart();
  assert.ok(context.__capturedChart.options.scales.y.min <= 3.5);
  assert.ok(context.__capturedChart.data.datasets.some(dataset => dataset.borderDash?.length));
  assert.equal(new Set(context.__capturedChart.data.datasets.map(dataset => JSON.stringify(dataset.borderDash || []))).size, context.__capturedChart.data.datasets.length);
}

function testChartPanelWrapperAndTokenDrivenConfig() {
  const html = fs.readFileSync('index.html', 'utf8');
  assert.match(html, /<div class="chart-box" id="chartPanel"[^>]*role="tabpanel"/);
  assert.match(html, /<div class="chart-canvas-wrap"><canvas id="growthChart"/);
  assert.match(html, /<p class="chart-description" id="chartDescription"/);

  context.document.documentElement = {};
  context.getComputedStyle = () => ({ getPropertyValue: token => token === '--accent-teal' ? 'rgb(1, 2, 3)' : '' });
  assert.equal(chart.chartColors().accent, 'rgb(1, 2, 3)');
  chart.setView('overall');
  chart.setState({ targets, attempts: [{ date: '2026-07-30', speaking: { band: 6.5 } }] });
  chart.renderChart();
  assert.equal(context.__capturedChart.data.datasets[0].borderColor, 'rgb(1, 2, 3)');
}

function testChartCssTokensAndMobileTabWrapping() {
  const css = fs.readFileSync('styles.css', 'utf8');
  assert.match(css, /--chart-control-height:\s*44px/);
  assert.match(css, /\.chart-canvas-wrap\s*\{[^}]*height:\s*var\(--chart-height-desktop\)/);
  assert.match(css, /\.chart-tab\s*\{[^}]*min-height:\s*var\(--chart-control-height\)/);
  const mobileStart = css.indexOf('@media (max-width: 620px)');
  const mobileEnd = css.indexOf('@media (prefers-reduced-motion: reduce)');
  const mobile = css.slice(mobileStart, mobileEnd);
  assert.match(mobile, /\.chart-tabs\s*\{[^}]*flex-wrap:\s*wrap;[^}]*overflow:\s*visible;[^}]*margin-right:\s*0;[^}]*padding:\s*0;/);
  assert.doesNotMatch(mobile, /overflow-x:\s*auto/);
}

testSameDayLabelsAndCoverageUseLatestComparableAttempt();
testMissingValuesKeepEverySeriesConnected();
testBandAndRawScaleBoundsIncludeAllValidValues();
testPartViewsUseOneHorizontalAverageAcrossLoggedValues();
testPartSelectionRecalculatesTheHorizontalAverageForThatPart();
testAverageReferenceIsVisuallyDistinctFromTheMainSeries();
testAverageReferenceUsesOneDecimalInTableAndTooltip();
testTabsUseTabpanelSemanticsAndActiveLabel();
testReducedMotionDisablesChartAnimation();
testOverlappingSeriesHavePatternAndLegendEncodings();
testSeriesSelectionKeepsAverageContext();
testCapturedChartConfigUsesModelBoundsAndPatterns();
testChartPanelWrapperAndTokenDrivenConfig();
testChartCssTokensAndMobileTabWrapping();
console.log('PASS chart regression: labels, gaps, bounds, coverage, tab semantics, reduced motion, and non-color patterns');
