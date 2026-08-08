# IELTS Progress Tracker Design System

## 1. Atmosphere & Identity

Calm academic progress dashboard: focused, reassuring, and quietly precise. The signature is a cool off-white canvas with deep navy type and restrained teal progress cues, using one mixed-depth strategy so cards feel layered without becoming glossy or loud.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|---|---|---|---|
| Surface / primary | `--surface-page` | `#f4f7f7` | Page canvas |
| Surface / elevated | `--surface-card` | `#ffffff` | Cards, forms, tables |
| Surface / subtle | `--surface-subtle` | `#f1f7f6` | Inputs, selected states |
| Text / primary | `--ink-strong` | `#14293b` | Headings and numbers |
| Text / secondary | `--ink-muted` | `#5f7180` | Captions and hints |
| Border / default | `--line-default` | `#dce7e8` | Dividers and outlines |
| Accent / primary | `--accent-teal` | `#0d9488` | CTAs, progress, links |
| Accent / hover | `--accent-teal-dark` | `#0f766e` | Hover and active states |
| Accent / soft | `--accent-teal-soft` | `#d9f3ef` | Focus rings and badges |
| Status / warning | `--status-warm` | `#c87912` | Remaining band gap |
| Status / error | `--status-error` | `#bd3453` | Destructive actions |
| Surface / danger | `--surface-danger` | `#fff5f7` | Destructive hover state |
| Border / danger | `--line-danger` | `#efc4cf` | Destructive control outline |

Use accent color for actions and meaningful progress only. Skill colors remain distinct data encodings and are declared as tokens in `styles.css`.

## 3. Typography

Primary font stack: `ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Numeric scores use the same stack with `font-variant-numeric: tabular-nums`. No external font assets are required.

| Level | Size | Weight | Usage |
|---|---:|---:|---|
| Page title | `clamp(1.5rem, 2vw, 1.75rem)` | 700 | Dashboard heading |
| Section title | `1.0625rem` | 650 | Card headings |
| Body | `0.9375rem` | 400 | Default copy |
| Secondary | `0.8125rem` | 500 | Hints and metadata |
| Caption | `0.6875rem` | 650 | Overlines and table heads |

## 4. Spacing & Layout

All spacing uses a 4px base. Tokens: `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4` 16px, `--space-5` 20px, `--space-6` 24px, `--space-8` 32px, `--space-10` 40px. Content is capped at 1240px with a two-column sidebar layout above 980px and a single-column flow below it. The history table owns horizontal scrolling on narrow screens; the document does not.

## 5. Components

### Cards and section headers
- **Structure:** `section.card > .card-head + content`.
- **Variants:** default, dark motivation, empty.
- **Spacing:** `--space-6` desktop, `--space-4` mobile; `--space-5` between groups.
- **States:** default, hover only where interactive, focus on controls, empty with explanatory copy.
- **Accessibility:** semantic headings and visible focus rings.

### Buttons and inputs
- **Structure:** native `button`, `input`, `select` with `.btn` or `.input`.
- **Variants:** primary, ghost, danger-outline.
- **States:** default, hover, active, focus-visible, disabled.
- **Accessibility:** keyboard reachable, 44px minimum touch target for icon actions, explicit labels.

### Test history table
- **Structure:** heading + count subtitle + scroll region + semantic table.
- **Variants:** populated, empty; each row is an independent attempt.
- **States:** row hover, delete focus, empty guidance.
- **Accessibility:** numeric columns use tabular figures; delete controls expose an attempt-specific accessible name.

### Trend chart
- **Structure:** title + explanation, four-cell summary, tablist, legend, plot, text description, and an equivalent data table.
- **Default:** an overall-first “Attempt average” line with a dashed average-target reference. Skill and part detail is available through explicit tabs; Listening and Reading also expose an `Average` comparison line computed from the logged parts.
- **Series controls:** the legend exposes an `aria-pressed` button for “All” and each measurable IELTS series. Selecting a Section or Passage keeps the `Average` comparison line visible; selecting a Writing task isolates that task, and views with a target reference retain that line for context.
- **States:** empty, one attempt, partial attempt, populated, target reached, and target gap.
- **Data semantics:** Listening and Reading averages use the available logged parts for each attempt; an attempt with no logged parts has no average point. Valid points remain connected across missing intermediate attempts, while solid versus dashed lines and text labels supplement color.
- **Responsive behavior:** 320px plot height on desktop/tablet and approximately 260px on mobile; tabs remain keyboard reachable and scroll within their own row when needed.
- **Accessibility:** tabs use `role="tablist"`/`role="tab"` with `aria-selected`; the canvas is decorative because the live description and screen-reader data table expose the same values. Summary copy always includes latest value, change, target gap, and skill coverage.

## 6. Motion & Interaction

Interactive transitions use 150–220ms ease-out for color, shadow, and transform. Progress ring and bars use the existing 400–900ms emphasis easing because they communicate score change. No decorative animation is introduced. `prefers-reduced-motion: reduce` disables transitions and smooth scrolling.

## 7. Depth & Surface

Strategy: mixed. Cards use a quiet 1px line plus a low-contrast teal-tinted shadow; controls use tonal shifts and focus rings. The motivation card is the only dark surface, using a restrained teal gradient for hierarchy.

## 8. Accessibility Constraints & Accepted Debt

- Maintain deep navy text on light surfaces and visible `:focus-visible` outlines.
- Preserve semantic landmarks, labels, and keyboard operation.
- Never rely on color alone for score meaning; include text values.
- Keep page content within the viewport; only wide data tables may scroll horizontally.
- Respect reduced motion and avoid emoji icons or external assets.
- Accepted debt: existing Firebase REST authentication and chart dependency remain unchanged; no new browser automation or package dependencies are introduced in this pass.
