# Score Growth redesign

## Status

Approved direction: Overall-first. The default view prioritizes one readable overall trend and a target reference; skill and part-level detail appears only after the learner chooses a skill.

## Problem

The current chart displays data, but it can mislead or hide results:

- The default five-line view is visually crowded.
- Band scores below 4.0 are clipped by the fixed Y-axis minimum.
- Reading passage scores above 14 are clipped even though inputs allow 0–20.
- Missing skill results are bridged by `spanGaps`, implying progress that was not measured.
- Same-day attempts can share identical X-axis labels.
- Partial attempts are presented as an unqualified overall score.
- Tabs and the canvas do not expose enough state or data to assistive technology.
- Explicit smooth scrolling ignores a learner's reduced-motion preference.

## Goals

1. Make the latest direction, change, and target gap understandable within a few seconds.
2. Preserve partial practice attempts without presenting them as complete IELTS tests.
3. Show every valid input value without clipping or invented continuity.
4. Keep the chart clear at 375px, 768px, and 1280px.
5. Make the chart controls and equivalent trend information keyboard- and screen-reader-accessible.
6. Keep the existing vanilla HTML, CSS, JavaScript, Chart.js, storage, and authentication architecture.

## Non-goals

- No changes to Firebase, authentication, cloud synchronization, or history persistence.
- No new charting dependency or build system.
- No prediction, forecasting, or statistical smoothing.
- No GitHub push or deployment in this implementation pass.

## Approaches considered

### 1. Overall-first with progressive drill-down — selected

Show one primary attempt-average trend plus a target line by default. Put Listening, Reading, Writing, and Speaking behind explicit tabs. This gives the fastest read while retaining the existing part-level detail.

### 2. All skills with interactive legend toggles

Keep all five series but let users hide lines. This preserves density, but the initial view remains crowded and requires interaction before it becomes clear.

### 3. Small multiples

Give each skill a mini-chart. This makes comparison reliable, but substantially increases page height and weakens the dashboard's single primary insight.

## Information design

### Trend summary

Place a compact summary strip between the chart header and tabs:

- **Latest:** the latest attempt average.
- **Change:** difference from the previous comparable attempt, with `No previous result` when unavailable.
- **Target gap:** remaining distance to the average target, or `Target reached`.
- **Coverage:** `n of 4 skills logged` so a partial attempt is never mistaken for a complete IELTS overall score.

Use text and signs in addition to color. Positive, neutral, and negative states reuse existing design-system status and ink tokens.

### Default chart

- Rename the first tab from **All skills** to **Overall**.
- Draw one solid primary series labelled **Attempt average**.
- Draw the average target as a thinner dashed reference labelled **Target**.
- Keep point markers visible and emphasize only the latest point.
- Label same-day attempts as `Jul 30 · #1`, `Jul 30 · #2`; a user label remains available in the tooltip.
- Tooltip content includes the full date, optional label, attempt average, and skill coverage.

### Skill drill-down

- **Listening:** four section series, 0–10 Y-axis; current band and band target remain in the summary.
- **Reading:** three passage series, 0–20 Y-axis; current band and band target remain in the summary.
- **Writing:** Task 1, Task 2, and weighted Writing band, 0–9 Y-axis.
- **Speaking:** Speaking band and target, 0–9 Y-axis.
- Use both color and line pattern for overlapping series. Legends display the same pattern, not color alone.

## Data correctness

- Use valid full-domain bounds for raw section and passage views.
- For band views, compute readable bounds from visible data and the target while never excluding a valid 0–9 value.
- Set `spanGaps: false`; an unlogged skill creates a visible break.
- Do not fabricate zero values for missing data.
- Keep the existing partial-attempt average calculation for compatibility, but call it **Attempt average** and always display its skill coverage.
- Apply the corrected band-axis behavior to the admin chart as well.

## Interaction and accessibility

- Mark the tab container as a tablist and each button as a tab with `aria-selected` and a relationship to the chart panel.
- Keep all tabs keyboard reachable with visible focus treatment and 44px touch targets on narrow screens.
- Give the chart region a concise live textual summary.
- Add a screen-reader data table containing attempt label/date, average, coverage, and the active view's values. The canvas itself is decorative once this equivalent data exists.
- Use descriptive legend text and line patterns so meaning does not depend on hue.
- Respect `prefers-reduced-motion` when calling `scrollIntoView`; use instant scrolling when reduced motion is requested.

## Responsive behavior

- Desktop and tablet chart height: 320px.
- Mobile chart height: approximately 260px, with the summary using a two-column grid and tabs scrolling or wrapping without document overflow.
- X-axis ticks auto-skip, but the first and latest attempts remain identifiable through points and tooltips.
- Empty and single-point states retain the same summary structure without implying a trend.

## Design-system changes

Update `DESIGN.md` before UI code to document a reusable **Trend chart** primitive with:

- summary, tabs, plot, legend, empty, and accessible-data states;
- solid primary versus dashed reference line semantics;
- responsive height and touch-target rules;
- non-color encoding and reduced-motion constraints.

No new palette is needed. All surface, ink, accent, line, status, spacing, type, focus, and motion values must trace to existing tokens.

## Implementation boundaries

- `DESIGN.md`: document the Trend chart primitive and constraints.
- `index.html`: add summary, tab semantics, chart description, and accessible data container.
- `styles.css`: add token-driven summary, legend-pattern, responsive, and accessible-only styles.
- `app.js`: build correct datasets, labels, bounds, summaries, ARIA states, and reduced-motion behavior.
- Regression tests: protect low bands, Reading values through 20, missing-data gaps, same-day labels, target line, coverage copy, and tab state.

## Verification

1. Run the existing history regression and JavaScript syntax checks.
2. Run new chart regression cases that fail against the current implementation and pass after the change.
3. Manually exercise empty, one-attempt, same-day, partial, and complete-test states.
4. Verify Overall and all four skill tabs at 375px, 768px, and 1280px.
5. Check keyboard focus, screen-reader equivalent data, tooltips, target line, gap breaks, and reduced-motion scrolling.
6. Run independent visual QA and the final acceptance gate before reporting completion.

## Accepted debt

- Chart.js remains the rendering dependency.
- Historical partial averages are preserved for compatibility and clarified through naming and coverage rather than recalculated.
- The admin view keeps a simpler single overall chart; it receives correctness fixes but not the full learner drill-down UI.
