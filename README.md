# IELTS Progress Tracker

A simple, single-page web app to track your **IELTS Academic** band scores across all four skills and watch your progress toward your goal.

## Features

- **Per-section score entry** — Reading (passage 1–3) and Listening (section 1–4) raw scores auto-convert to band scores using the standard IELTS Academic conversion tables.
- **Writing & Speaking** — enter band scores (Writing combines Task 1 + Task 2, with Task 2 weighted double like the real exam).
- **Goal tracking** — set a target band per skill; the overall ring shows `target / current` and fills as you approach your goal.
- **Distance to Goal** — colour-coded progress bars per skill with a labelled target marker.
- **Growth chart** — a line chart (Chart.js) showing how each skill and your overall band change over time.
- **Test history** — append-only per-attempt history. Every saved result keeps its own attempt ID, so tests taken on the same date, including blank-label tests, remain separate rows. Cloud sync only merges replicas that carry the same attempt ID.
- **Backup** — export your data to a `.json` file and import it on any device. Everything is stored locally in your browser (`localStorage`); no account or server needed.

## Run locally

It's a static site — just open `index.html` in a browser. Or serve it:

```bash
python -m http.server 8123
# then open http://localhost:8123
```

## Tech

Plain HTML, CSS and JavaScript. Charts via the checked-in Chart.js runtime. No build step.
