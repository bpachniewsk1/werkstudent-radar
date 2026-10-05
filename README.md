# 🎯 Werkstudent Radar · Dresden

Finds **Werkstudent jobs around Dresden that fit an economics student** and ranks them,
preferring jobs **close to 20 h/week**.

👉 **Open the app: https://bpachniewsk1.github.io/werkstudent-radar/**

On a phone: open the link → *Share* → **Add to Home Screen**. It then works like an app.

## What it does

1. Pulls live listings from the **Bundesagentur für Arbeit** job search ("Werkstudent",
   "Werkstudentin", "Working Student", "Student", "studentische Aushilfe", within 40 km of Dresden).
   It updates **automatically 3× a day** (≈ 6:00, 12:00, 18:00).
2. Reads every job description and **estimates weekly hours** ("16–20 Std./Woche",
   "bis zu 20h", "2–3 Tage pro Woche" ≈ 16–24 h, etc.).
3. Gives each job a **fit score (0–100)**:
   - 60 % economics match (Finance, Controlling, BWL/VWL, Consulting, Data, Marketing, Einkauf, HR…)
   - 25 % hours (20 h = perfect, 15 h = good, ≤ 10 h = meh)
   - 15 % is it really a Werkstudent job (dual study / full-time jobs are hidden by default)
4. Shows the **source of every job**: which site originally published it (e.g. finest-jobs.com,
   Empfehlungsbund, the employer itself), plus a link to the arbeitsagentur.de page where the
   description text came from, the job reference number and when it was fetched (open *Details*).
5. Lets you **save → apply → interview → offer** and keep notes per job (tab *My applications*).
6. Marks jobs that are **NEW** in the last 7 days, and shows everything on a **map**.
7. Links to the boards it can't read automatically (Stellenwerk Dresden, TU Dresden SHK jobs,
   LinkedIn, Indeed, StepStone, ifo Dresden…).

## Your saved jobs & notes

They are stored **only in the browser you use** (nothing is uploaded, the repo never sees them).
That means:

- Phone and laptop each have their own list.
- Clearing browser data deletes the list. Use **⬇️ Backup** in *My applications* now and then,
  and **⬆️ Restore** to bring it back (or to move it to another device).

## How it works

```
GitHub Action (3× a day)                    GitHub Pages
python app.py --refresh  ──► web/data/jobs.json ──► static site in web/
```

- `app.py`: fetches + scores listings (Python standard library only, no installs).
- `web/`: the app (plain HTML/CSS/JS).
- `.github/workflows/update.yml`: runs the refresh, commits the new `jobs.json`, deploys the site.

**Refresh right now:** GitHub → *Actions* → *Update jobs & publish* → *Run workflow*.

> GitHub pauses scheduled workflows in public repos after 60 days without activity. The
> automatic data commits should prevent that, but if updates ever stop, open the *Actions*
> tab and click *Enable workflow*.

## Run it locally (optional)

```bash
python3 app.py
```

Opens http://localhost:8765 (on a Mac you can also double-click `start.command`).
The **Refresh** button then fetches brand-new listings immediately.

## Tweaking

All the keyword lists and weights are at the top of `app.py` (`CATEGORIES`, `ECON_STRONG`,
`ECON_MEDIUM`, `OFF_TOPIC`, `SEARCH_TERMS`). Add words there if a good job ranks too low,
then push. The site rebuilds automatically.
