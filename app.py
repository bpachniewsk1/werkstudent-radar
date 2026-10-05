#!/usr/bin/env python3
"""Werkstudent Radar – Dresden.

Finds Werkstudent jobs around Dresden that fit an economics student,
estimates weekly hours from the job text and ranks everything by fit.

Zero dependencies.
  python3 app.py --refresh   fetch listings → web/data/jobs.json (what the GitHub Action runs)
  python3 app.py             local preview server → http://localhost:8765
"""

import base64
import json
import os
import re
import sys
import threading
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
JOBS_FILE = ROOT / "web" / "data" / "jobs.json"  # published with the site
SEEN_FILE = DATA / "seen.json"  # when each job first showed up (for NEW badges)
DETAILS_CACHE = DATA / "details_cache.json"  # avoids re-downloading unchanged descriptions

PORT = int(os.environ.get("PORT", 8765))
HOST = os.environ.get("HOST", "127.0.0.1")

# Public API of the Bundesagentur für Arbeit (the same one their own app uses).
BA_API = "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service"
BA_HEADERS = {"X-API-Key": "jobboerse-jobsuche", "User-Agent": "werkstudent-radar/1.0"}
BA_JOB_URL = "https://www.arbeitsagentur.de/jobsuche/jobdetail/{}"

LOCATION = "Dresden"
DEFAULT_RADIUS_KM = 40  # fetch wide; the app filters by distance
SEARCH_TERMS = ["Werkstudent", "Werkstudentin", "Working Student", "Student", "studentische Aushilfe"]
REFRESH_EVERY_HOURS = 6

# ---------------------------------------------------------------- scoring --

# (category, emoji, keywords). Order = priority when a job matches several.
CATEGORIES = [
    ("Finance & Controlling", "💶", ["finanz", "finance", "controlling", "controller", "rechnungswesen", "buchhalt",
                                     "accounting", "steuer", "tax", "audit", "wirtschaftsprüf", "treasury", "bank",
                                     "versicherung", "insurance", "invest", "m&a", "corporate finance", "risk", "kredit",
                                     "fördermittel", "budget", "kalkulation", "lohn", "payroll"]),
    ("Economics & Research", "🏛️", ["volkswirt", "vwl", "economics", "economist", "ökonom", "wirtschaftsforschung",
                                    "wirtschaftspolitik", "research", "forschung", "wissenschaftlich", "ifo", "studie",
                                    "marktforschung", "market research", "policy", "regionalentwicklung"]),
    ("Data & Analytics", "📊", ["data analyst", "datenanaly", "analytics", "business intelligence", "power bi",
                               "tableau", "statistik", "statistic", "reporting", "auswertung", "kennzahlen", "kpi",
                               "dashboard", "analyst"]),
    ("Consulting & Strategy", "🧭", ["beratung", "consult", "strateg", "unternehmensentwicklung", "business development",
                                    "projektmanagement", "project management", "pmo", "transformation", "innovation",
                                    "prozessmanagement", "process"]),
    ("Procurement & Supply Chain", "🚚", ["einkauf", "procurement", "purchasing", "supply chain", "beschaffung",
                                         "logistikmanagement", "disposition", "materialwirtschaft"]),
    ("Sales & Business", "🤝", ["vertrieb", "sales", "key account", "account manag", "kundenbetreuung", "business"]),
    ("Marketing & Communication", "📣", ["marketing", "social media", "kommunikation", "communication", "pr ",
                                        "content", "brand", "marke", "e-commerce", "ecommerce", "seo", "redaktion",
                                        "event"]),
    ("HR & People", "👥", ["personal", "human resources", "hr ", "hr-", "(hr)", "recruit", "talent", "people"]),
    ("Office & Administration", "🗂️", ["kaufmännisch", "büro", "verwaltung", "administration", "assistenz",
                                      "assistant", "office", "sachbearbeit", "backoffice", "organisation"]),
]

# Words that make a job a good match for an economics student, with weights.
ECON_STRONG = ["wirtschaftswissenschaft", "wirtschaftswiss", "betriebswirt", "bwl", "volkswirt", "vwl", "economics",
               "ökonom", "economist", "finance", "finanz", "controlling", "rechnungswesen", "accounting",
               "wirtschaftsprüf", "audit", "steuerberat", "tax", "business administration", "wirtschaftsinformatik",
               "business analyst", "data analyst", "datenanaly", "corporate finance", "m&a", "treasury", "bank",
               "marktforschung", "market research", "wirtschaftsforschung", "statistik", "consult", "unternehmensberatung"]
ECON_MEDIUM = ["wirtschaft", "kaufmännisch", "business", "einkauf", "procurement", "supply chain", "vertrieb", "sales",
               "marketing", "personal", "human resources", "recruit", "projektmanagement", "project manage", "strateg",
               "analyse", "analysis", "analytics", "reporting", "kennzahlen", "kpi", "excel", "power bi", "budget",
               "kalkulation", "buchhalt", "fördermittel", "versicherung", "e-commerce", "beratung", "research",
               "forschung", "verwaltung", "sachbearbeit", "office", "assistenz", "kommunikation", "social media",
               "nachhaltigkeit", "sustainability", "vertrag", "projektentwicklung", "digitalisierung", "pricing",
               "onlinehandel", "marktplatz", "immobilien", "real estate"]
# Job titles/professions that clearly are *not* for an economics student.
OFF_TOPIC = ["softwareentwick", "software developer", "software engineer", "developer", "entwickler", "programmier",
             "ingenieur", "engineer", "elektro", "elektronik", "mechatron", "maschinenbau", "bauingenieur", "tiefbau",
             "hochbau", "vermess", "architekt", "pflege", "medizin", "zahn", "zfa", "arzt", "therap", "labor",
             "chemie", "chemiker", "physik", "biolog", "lager", "fahrer", "kommissionier", "koch", "küche", "gastro",
             "service-kraft", "servicekraft", "reinigung", "erzieh", "pädagog", "informatiker", "fachinformatik",
             "it-support", "systemadministr", "devops", "cyber", "security", "ki-engineer", "machine learning",
             "frontend", "backend", "full-stack", "fullstack", "web developer", "testingenieur", "hardware",
             "callcenter", "ernährung", "rezept", "techniker", "monteur", "handwerk", "verkäufer/in", "kassier",
             "referatsleitung", "abteilungsleit", "teamleit", "geschäftsführ", "jurist", "rechtsanwalt"]

STUDENT_TITLE = ["werkstudent", "working student", "studentisch", "student", "studierende", "hilfskraft", "shk",
                 "studentenjob", "aushilfe", "praktikant/werkstudent"]
# Dual study / apprenticeships are whole degree programs, not side jobs for someone already studying.
NOT_STUDENT_JOB = ["phd", "postdoc", "doktorand", "research associate", "festangestellte", "wissenschaftliche mitarbeit"]
DUAL_STUDY = ["dualer student", "duale student", "duales studium", "dualen studium", "duale(r)", "dual student",
              "ba-student", "bachelor of arts –", "bachelor of arts -", "ausbildung", "azubi", "auszubildende"]

HOUR_UNIT = r"(?:h\b|std\b\.?|std\.|stunden|stunde|wochenstunden|hours|hrs|hour)"
WEEK_CONTEXT = (r"(?:woche|wöchentlich|/\s*wo\b|wochenarbeitszeit|per week|a week|per\s*wk|weekly|/\s*week|"
                r"pro\s*woche|wochenstunden|teilzeit|part[- ]time|werkstudent)")
NUM = r"(\d{1,2}(?:[.,]\d)?)"
RANGE_SEP = r"\s*(?:-|–|—|bis|to|und|/)\s*"

RE_RANGE = re.compile(NUM + r"\s*(?:" + HOUR_UNIT + r")?" + RANGE_SEP + NUM + r"\s*-?\s*" + HOUR_UNIT, re.I)
RE_SINGLE = re.compile(NUM + r"\s*-?\s*" + HOUR_UNIT, re.I)
RE_HOURS_WEEK = re.compile(NUM + r"\s*-?\s*(?:h|std|stunden)\s*-?\s*woche", re.I)
SEMESTER_BREAK = re.compile(r"semesterferien|vorlesungsfrei|semester break|ferien|holidays", re.I)

DAY_WORDS = {"ein": 1, "einen": 1, "eins": 1, "one": 1, "zwei": 2, "two": 2, "drei": 3, "three": 3,
             "vier": 4, "four": 4, "fünf": 5, "five": 5}
DAY_NUM = r"(\d|ein|einen|zwei|drei|vier|fünf|one|two|three|four|five)"
RE_DAYS = re.compile(DAY_NUM + r"(?:\s*(?:-|–|bis|to|oder|or)\s*" + DAY_NUM + r")?\s*"
                     r"(?:arbeits)?(?:tage|tagen|days)\s*(?:pro|die|in der|je|/|per|a)\s*(?:woche|week)", re.I)
RE_DAYS_NOT_WORK = re.compile(r"mobil|home|remote|homeoffice|urlaub|vacation", re.I)


def _num(s):
    return float(s.replace(",", "."))


def _day(s):
    return int(s) if s.isdigit() else DAY_WORDS[s.lower()]


def parse_days(flat):
    """'2-3 Tage pro Woche' → hours estimate (8h per day), ignoring home-office/vacation days."""
    for m in RE_DAYS.finditer(flat):
        if RE_DAYS_NOT_WORK.search(flat[max(0, m.start() - 40): m.end() + 40]):
            continue
        lo = _day(m.group(1))
        hi = _day(m.group(2)) if m.group(2) else lo
        if 1 <= lo <= hi <= 4:
            s = max(0, flat.rfind(".", 0, m.start()) + 1, m.start() - 120)
            e = flat.find(".", m.end())
            e = len(flat) if e == -1 or e - m.end() > 120 else e + 1
            return lo * 8.0, hi * 8.0, flat[s:e].strip()
    return None, None, None


def parse_hours(text):
    """Best guess of weekly hours during the semester → (min, max, snippet, estimated).

    Returns (None, None, None, False) when the text doesn't say.
    """
    if not text:
        return None, None, None, False
    flat = re.sub(r"\s+", " ", text)
    found = []  # (lo, hi, start, end)

    def near_week(m):
        window = flat[max(0, m.start() - 70): m.end() + 70]
        return re.search(WEEK_CONTEXT, window, re.I) is not None

    def in_semester_break(m):
        # Only look inside the same clause: "Semesterferien bis 40h, im Semester 20h" → keep the 20h.
        clause_start = max(flat.rfind(c, 0, m.start()) for c in ".,;:•") + 1
        clause_end = min([i for i in (flat.find(c, m.end()) for c in ".,;•(") if i != -1] or [len(flat)])
        clause = flat[max(clause_start, m.start() - 60): min(clause_end, m.end() + 40)]
        return SEMESTER_BREAK.search(clause) is not None

    for m in RE_RANGE.finditer(flat):
        lo, hi = _num(m.group(1)), _num(m.group(2))
        if 3 <= lo < hi <= 40 and (near_week(m) or "wochenstunden" in m.group(0).lower()):
            if not in_semester_break(m):
                found.append((lo, hi, m.start(), m.end()))
    for m in list(RE_SINGLE.finditer(flat)) + list(RE_HOURS_WEEK.finditer(flat)):
        h = _num(m.group(1))
        if any(s <= m.start() < e for _, _, s, e in found):
            continue
        if 3 <= h <= 40 and h != 24 and (near_week(m) or "woche" in m.group(0).lower()) and not in_semester_break(m):
            found.append((h, h, m.start(), m.end()))

    if not found:
        lo, hi, snippet = parse_days(flat)
        return lo, hi, snippet, lo is not None
    # Prefer realistic Werkstudent values (≤ 20h); full-time numbers usually describe the team, not the role.
    student_range = [f for f in found if f[0] <= 20] or found
    lo = min(f[0] for f in student_range)
    hi = max(f[1] for f in student_range)
    first = min(student_range, key=lambda f: f[2])
    s = max(0, flat.rfind(".", 0, first[2]) + 1, first[2] - 140)
    e = flat.find(".", first[3])
    e = len(flat) if e == -1 or e - first[3] > 140 else e + 1
    return lo, hi, flat[s:e].strip(), False


def hours_score(lo, hi, job):
    """1.0 = right at ~20h/week, lower the further away (or unknown)."""
    if hi is None:
        if job.get("istGeringfuegigeBeschaeftigung"):
            return 0.25  # Minijob → usually only a few hours
        if job.get("arbeitszeitVollzeit") and not job.get("is_student_job"):
            return 0.2
        return 0.55
    if lo <= 20 <= hi or 18 <= hi <= 22:
        return 1.0
    best = hi if hi < 20 else lo
    if best >= 30:
        return 0.1  # full-time
    if best > 22:
        return 0.5  # more than Werkstudent rules allow during the semester
    if best >= 15:
        return 0.8
    if best >= 12:
        return 0.5
    return 0.25


def count_hits(text, words):
    return sum(1 for w in words if w in text)


def classify(job):
    title = (job.get("stellenangebotsTitel") or "").lower()
    berufe = " ".join(job.get("alleBerufe") or [job.get("hauptberuf") or ""]).lower()
    desc = (job.get("description") or "").lower()
    head = f"{title} {berufe}"

    strong_title, medium_title = count_hits(title, ECON_STRONG), count_hits(title, ECON_MEDIUM)
    strong_prof, medium_prof = count_hits(berufe, ECON_STRONG), count_hits(berufe, ECON_MEDIUM)
    strong_desc, medium_desc = count_hits(desc, ECON_STRONG), count_hits(desc, ECON_MEDIUM)
    off_title, off_prof = count_hits(title, OFF_TOPIC), count_hits(berufe, OFF_TOPIC)

    raw = (0.4 * strong_title + 0.25 * medium_title + 0.2 * strong_prof + 0.1 * medium_prof
           + 0.07 * min(strong_desc, 5) + 0.025 * min(medium_desc, 6))
    # The job title is the employer's own words; the BA profession tag is often a rough guess.
    if off_title:
        raw -= 0.6 + 0.1 * min(off_title, 3)
    elif off_prof and not (strong_title or medium_title):
        raw -= 0.25
    econ = max(0.0, min(1.0, raw))
    off = off_title or (off_prof and not (strong_title or medium_title))

    category, emoji = "Other", "✨"
    for name, emo, words in CATEGORIES:
        if any(w in head for w in words):
            category, emoji = name, emo
            break
    else:
        for name, emo, words in CATEGORIES:
            if count_hits(desc, words) >= 2:
                category, emoji = name, emo
                break
    if off and econ < 0.25:
        category, emoji = "Other", "✨"
    return econ, category, emoji


# ------------------------------------------------------------- data access --

def load_json(path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)


def ba_get(path, params=None, retries=2):
    url = f"{BA_API}/{path}" + (f"?{urlencode(params)}" if params else "")
    for attempt in range(retries + 1):
        try:
            with urlopen(Request(url, headers=BA_HEADERS), timeout=25) as r:
                return json.loads(r.read().decode("utf-8"))
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError):
            if attempt == retries:
                raise
            time.sleep(1.5 * (attempt + 1))


def search_all(term, radius):
    jobs, page = [], 1
    while True:
        res = ba_get("pc/v6/jobs", {"was": term, "wo": LOCATION, "umkreis": radius, "size": 100, "page": page})
        batch = res.get("ergebnisliste") or []
        jobs += batch
        if len(batch) < 100 or len(jobs) >= res.get("maxErgebnisse", 0) or page >= 5:
            return jobs
        page += 1


def details_path(refnr):
    return f"pc/v4/jobdetails/{base64.b64encode(refnr.encode()).decode()}"


def fetch_details(refnr):
    try:
        det = ba_get(details_path(refnr), retries=1)
        det["_fetched"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return det
    except Exception:
        return {}


def _site_url(url):
    if not url:
        return None
    return url if url.startswith("http") else "https://" + url.lstrip("/")


def describe_source(refnr, det, external_url):
    """Where the job (and its description text) came from, so every listing can be traced back."""
    partner = (det.get("allianzpartnerName") or "").strip()
    partner_url = _site_url(det.get("allianzpartnerUrl"))
    direct = not partner or partner.lower() == "arbeitsagentur.de"
    ba_page = BA_JOB_URL.format(refnr)
    return {
        "description_from": "Bundesagentur für Arbeit (Jobsuche)",
        "description_url": ba_page,
        "api_url": f"{BA_API}/{details_path(refnr)}",
        "reference": refnr,
        "published_by": "arbeitsagentur.de" if direct else partner,
        "published_by_url": "https://www.arbeitsagentur.de" if direct else partner_url,
        "direct": direct,
        "original_url": external_url,
        "original_site": urlparse(external_url).netloc.removeprefix("www.") if external_url else "arbeitsagentur.de",
        "fetched_at": det.get("_fetched"),
    }


def refresh(radius=DEFAULT_RADIUS_KM, log=print):
    t0 = time.time()
    found = {}
    for term in SEARCH_TERMS:
        try:
            for j in search_all(term, radius):
                found.setdefault(j["referenznummer"], j)
        except Exception as e:  # one failing term shouldn't kill the refresh
            log(f"  ! search '{term}' failed: {e}")
    log(f"  {len(found)} unique listings from {len(SEARCH_TERMS)} searches")

    cache = load_json(DETAILS_CACHE, {})
    todo = [r for r, j in found.items()
            if cache.get(r, {}).get("_changed") != j.get("aenderungsdatum")]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for refnr, det in zip(todo, pool.map(fetch_details, todo)):
            det["_changed"] = found[refnr].get("aenderungsdatum")
            cache[refnr] = det
    cache = {r: d for r, d in cache.items() if r in found}  # drop expired listings
    save_json(DETAILS_CACHE, cache)
    log(f"  fetched {len(todo)} new/changed job descriptions")

    seen = load_json(SEEN_FILE, {})
    first_run = not seen
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    jobs = []
    for refnr, j in found.items():
        det = cache.get(refnr, {})
        job = {**j, **{k: v for k, v in det.items() if not k.startswith("_")}}
        desc = det.get("stellenangebotsBeschreibung") or ""
        job["description"] = desc
        title = job.get("stellenangebotsTitel") or ""
        title_l = title.lower()
        dual_study = any(w in title_l for w in DUAL_STUDY) or job.get("stellenangebotsart") == "AUSBILDUNG"
        student_title = (any(w in title_l for w in STUDENT_TITLE) and not dual_study
                         and not any(w in title_l for w in NOT_STUDENT_JOB))
        student_desc = "werkstudent" in desc.lower() or "working student" in desc.lower()
        job["is_student_job"] = student_title or student_desc

        lo, hi, snippet, estimated = parse_hours(f"{title}. {desc}")
        econ, category, emoji = classify(job)
        hs = hours_score(lo, hi, job)
        student = 1.0 if student_title else 0.6 if student_desc else 0.0
        fit = round(100 * (0.6 * econ + 0.25 * hs + 0.15 * student))
        if dual_study:
            fit = min(fit, 15)
        elif not job["is_student_job"]:
            fit = min(fit, 45)  # regular part-/full-time job – only interesting if nothing else fits

        if refnr not in seen:
            seen[refnr] = {"first_seen": now, "initial": first_run}

        loc = _closest_location(job.get("stellenlokationen"))
        addr = loc.get("adresse") or {}
        jobs.append({
            "id": refnr,
            "title": title,
            "company": job.get("firma") or "",
            "city": addr.get("ort") or "",
            "district": addr.get("ortsteil") or "",
            "plz": addr.get("plz") or "",
            "street": " ".join(x for x in [addr.get("strasse"), addr.get("hausnummer")] if x),
            "lat": loc.get("breite"), "lon": loc.get("laenge"),
            "distance_km": job.get("entfernung"),
            "profession": job.get("hauptberuf") or "",
            "type": job.get("stellenangebotsart") or "",
            "hours_min": lo, "hours_max": hi, "hours_snippet": snippet, "hours_estimated": estimated,
            "dual_study": dual_study,
            "full_time": bool(job.get("arbeitszeitVollzeit")),
            "minijob": bool(job.get("istGeringfuegigeBeschaeftigung")),
            "homeoffice": bool(job.get("homeofficemoeglich")) or bool(job.get("homeofficeprozent")),
            "salary": _salary(job),
            "start": (job.get("eintrittszeitraum") or {}).get("von"),
            "published": job.get("datumErsteVeroeffentlichung") or (job.get("veroeffentlichungszeitraum") or {}).get("von"),
            "updated": job.get("aenderungsdatum"),
            "url": job.get("externeURL") or BA_JOB_URL.format(refnr),
            "ba_url": BA_JOB_URL.format(refnr),
            "external": bool(job.get("externeURL")),
            "source": describe_source(refnr, det, job.get("externeURL")),
            "description": desc,
            "is_student_job": job["is_student_job"],
            "category": category, "emoji": emoji,
            "scores": {"econ": round(econ, 2), "hours": round(hs, 2), "student": student},
            "fit": fit,
            "first_seen": seen[refnr]["first_seen"],
            "initial": seen[refnr].get("initial", False),
        })

    # forget jobs that have been offline for a long time
    cutoff = time.time() - 120 * 86400
    seen = {r: v for r, v in seen.items()
            if r in found or datetime.fromisoformat(v["first_seen"]).timestamp() > cutoff}
    save_json(SEEN_FILE, seen)
    jobs.sort(key=lambda x: -x["fit"])
    result = {"updated_at": now, "radius": radius, "count": len(jobs), "jobs": jobs,
              "took_s": round(time.time() - t0, 1)}
    save_json(JOBS_FILE, result)
    log(f"  done in {result['took_s']}s")
    return result


DRESDEN = (51.0504, 13.7373)


def _closest_location(locations):
    """Multi-city listings ("Nürnberg, München, Dresden…") → pick the Dresden-area one."""
    def dist(loc):
        if "dresden" in ((loc.get("adresse") or {}).get("ort") or "").lower():
            return -1
        lat, lon = loc.get("breite"), loc.get("laenge")
        return (lat - DRESDEN[0]) ** 2 + (lon - DRESDEN[1]) ** 2 if lat and lon else 1e9
    return min(locations or [{}], key=dist)


def _salary(job):
    lo, hi = job.get("gehaltsspanneVon"), job.get("gehaltsspanneBis")
    unit = {"STUNDE": "/h", "MONAT": "/month", "JAHR": "/year"}.get(job.get("artDerVerguetung") or "", "")
    if job.get("festgehalt"):
        return f"{job['festgehalt']} €{unit}"
    if lo and hi:
        return f"{lo}–{hi} €{unit}"
    if lo:
        return f"from {lo} €{unit}"
    return None


# ---------------------------------------------------------------- server --
# Only for running it locally. The hosted version is static files + a GitHub Action.

_refresh_lock = threading.Lock()


def refresh_if_stale():
    current = load_json(JOBS_FILE, None)
    age = time.time() - datetime.fromisoformat(current["updated_at"]).timestamp() if current else 1e9
    if age > REFRESH_EVERY_HOURS * 3600:
        with _refresh_lock:
            print("Refreshing jobs…")
            refresh()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT / "web"), **kw)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if urlparse(self.path).path != "/api/refresh":
            return super().do_GET()
        try:
            with _refresh_lock:
                result = refresh()
            body, status = json.dumps({"ok": True, "count": result["count"]}), 200
        except Exception as e:
            body, status = json.dumps({"ok": False, "error": str(e)}), 502
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())


def main():
    url = f"http://localhost:{PORT}"
    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError:
        print(f"\n  Werkstudent Radar seems to be running already → {url}\n")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return
    refresh_if_stale()
    print(f"\n  Werkstudent Radar running → {url}\n  (Ctrl+C to stop)\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye 👋")


if __name__ == "__main__":
    if "--refresh" in sys.argv:
        refresh()
    else:
        main()
