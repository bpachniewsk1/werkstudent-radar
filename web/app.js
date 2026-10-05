// Werkstudent Radar – frontend (vanilla JS, no build step)

const DEFAULT_FILTERS = {
  q: "", hours: "any", includeUnknown: true, minFit: 45, cats: [], onlyNew: false,
  showOther: false, showHidden: false, sort: "fit", layout: "list",
};

const STATUSES = {
  saved: { label: "⭐ Saved", short: "Saved" },
  applied: { label: "📨 Applied", short: "Applied" },
  interview: { label: "💬 Interview", short: "Interview" },
  offer: { label: "🎉 Offer", short: "Offer" },
  rejected: { label: "❌ Rejected", short: "Rejected" },
  hidden: { label: "🙈 Hidden", short: "Hidden" },
};
const PIPELINE_COLS = ["saved", "applied", "interview", "offer"];

const BOARDS = [
  { group: "Student job portals" },
  { e: "🎓", name: "Stellenwerk Dresden", url: "https://www.stellenwerk.de/dresden",
    d: "Official student job portal of TU Dresden & HTW. Lots of Werkstudent jobs that never reach other boards.", tag: "Check weekly" },
  { e: "🏛️", name: "TU Dresden – job offers", url: "https://tu-dresden.de/karriere/stellenangebote",
    d: "Student assistant (SHK) jobs at the university, e.g. at the Faculty of Business & Economics chairs.", tag: "Great for economics" },
  { e: "📈", name: "ifo Institut (Dresden branch)", url: "https://www.ifo.de/karriere",
    d: "Economic research institute with an office in Dresden. Hires student assistants for research projects.", tag: "Economics research" },
  { e: "🌱", name: "IÖR Dresden", url: "https://www.ioer.de/karriere",
    d: "Leibniz Institute of Ecological Urban & Regional Development. Student assistant jobs in regional economics.", tag: "Research" },

  { group: "Big job boards (pre-filled search)" },
  { e: "💼", name: "LinkedIn Jobs", url: "https://www.linkedin.com/jobs/search/?keywords=Werkstudent%20Wirtschaft&location=Dresden",
    d: "Many corporates (Infineon, GlobalFoundries, SAP, Bosch…) post their Werkstudent roles here first.", tag: "Set a job alert" },
  { e: "🔎", name: "Indeed", url: "https://de.indeed.com/jobs?q=Werkstudent+Wirtschaft&l=Dresden",
    d: "Big aggregator. Lots of smaller companies.", tag: "Set a job alert" },
  { e: "🪜", name: "StepStone", url: "https://www.stepstone.de/jobs/werkstudent-wirtschaft/in-dresden",
    d: "Strong for finance, controlling and consulting roles.", tag: "" },
  { e: "🟢", name: "XING Jobs", url: "https://www.xing.com/jobs/search?keywords=Werkstudent&location=Dresden",
    d: "German professional network. Good for Mittelstand companies.", tag: "" },
  { e: "🏢", name: "Arbeitsagentur Jobsuche", url: "https://www.arbeitsagentur.de/jobsuche/suche?was=Werkstudent&wo=Dresden&umkreis=25",
    d: "The source this radar reads from, in case you want to browse it yourself.", tag: "" },

  { group: "Dresden employers worth a direct look" },
  { e: "🏦", name: "Sächsische Aufbaubank (SAB)", url: "https://www.sab.sachsen.de/karriere",
    d: "Saxony's development bank, based in Dresden. Finance, funding programmes, economics.", tag: "Finance" },
  { e: "🐷", name: "Ostsächsische Sparkasse Dresden", url: "https://www.ostsaechsische-sparkasse-dresden.de/de/home/ihre-sparkasse/karriere.html",
    d: "Regional savings bank. Werkstudent roles in banking, controlling and marketing.", tag: "Banking" },
];

const state = {
  data: null,
  tracker: {},
  view: "discover",
  filters: loadFilters(),
  expanded: new Set(),
  map: null,
  mapLayer: null,
};

// ------------------------------------------------------------ utilities --

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loadFilters() {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem("wr-filters") || "{}") };
  } catch { return { ...DEFAULT_FILTERS }; }
}
function saveFilters() {
  try { localStorage.setItem("wr-filters", JSON.stringify(state.filters)); } catch {}
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

function daysAgo(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}
function relDate(iso) {
  const d = daysAgo(iso);
  if (d === null) return "";
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  if (d < 30) return `${Math.floor(d / 7)} wk ago`;
  if (d < 365) return `${Math.floor(d / 30)} mo ago`;
  return `${Math.floor(d / 365)} yr ago`;
}

function cleanTitle(job) {
  // Many BA titles are "Company: Title" or have ",City,City" tails.
  let t = job.title || "";
  if (job.company && t.toLowerCase().startsWith(job.company.toLowerCase() + ":")) t = t.slice(job.company.length + 1);
  t = t.replace(/^[^:]{3,60}(GmbH|AG|SE|KG|e\.V\.|mbH)[^:]*:\s*/, "");
  t = t.replace(/(,\s*[A-ZÄÖÜ][\wäöüß.-]+){2,}\s*$/, "");
  return t.trim();
}

function isNew(job) {
  return !job.initial && daysAgo(job.first_seen) !== null && daysAgo(job.first_seen) < 7;
}

function hoursInfo(job) {
  const lo = job.hours_min, hi = job.hours_max;
  if (hi == null) {
    if (job.minijob) return { text: "Minijob", cls: "h-warn" };
    if (job.full_time && !job.is_student_job) return { text: "Full-time", cls: "h-bad" };
    return { text: "hours not stated", cls: "h-none" };
  }
  const approx = job.hours_estimated ? "~" : "";
  const fmt = n => (Number.isInteger(n) ? n : n.toFixed(1)).toString();
  const text = `⏱ ${approx}${lo === hi ? fmt(hi) : fmt(lo) + "–" + fmt(hi)} h/wk`;
  let cls;
  if ((lo <= 20 && hi >= 20) || (hi >= 18 && hi <= 22)) cls = "h-good";
  else if (hi > 22) cls = "h-warn";
  else if (hi >= 15) cls = "h-ok";
  else if (hi >= 12) cls = "h-warn";
  else cls = "h-bad";
  return { text, cls };
}

function hoursDistance(job) {
  if (job.hours_max == null) return 99;
  if (job.hours_min <= 20 && job.hours_max >= 20) return 0;
  return Math.min(Math.abs(job.hours_max - 20), Math.abs(job.hours_min - 20));
}

function sourceLine(src) {
  if (!src) return "";
  const link = (url, text) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const ba = link(src.description_url, "arbeitsagentur.de");
  if (src.original_url) {
    // skip "published by Jobstairs" when the site is jobstairs.de anyway
    const firstWord = (src.published_by || "").toLowerCase().split(/[\s.]/)[0];
    const by = !src.direct && firstWord && !src.original_site.toLowerCase().includes(firstWord)
      ? ` (published by ${esc(src.published_by)})` : "";
    return `<div class="source">📄 Source: ${link(src.original_url, src.original_site)}${by} · description via ${ba}</div>`;
  }
  if (!src.direct) return `<div class="source">📄 Source: ${ba} · submitted by ${esc(src.published_by)}</div>`;
  return `<div class="source">📄 Source: ${ba} (posted directly by the employer)</div>`;
}

function sourceBlock(src) {
  if (!src) return "";
  const fetched = src.fetched_at
    ? new Date(src.fetched_at).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }) : "unknown";
  const publisher = src.published_by_url
    ? `<a href="${esc(src.published_by_url)}" target="_blank" rel="noopener">${esc(src.published_by)} ↗</a>`
    : esc(src.published_by);
  return `
    <div class="provenance">
      <b>📄 Where this description comes from</b>
      <ul>
        <li>Text below: <b>${esc(src.description_from)}</b>, job ref <code>${esc(src.reference)}</code>.
          <a href="${esc(src.description_url)}" target="_blank" rel="noopener">View it on arbeitsagentur.de ↗</a></li>
        <li>Originally published by: ${publisher}${src.direct ? " (posted directly by the employer)" : ""}</li>
        ${src.original_url ? `<li>Original listing (apply here): <a href="${esc(src.original_url)}" target="_blank" rel="noopener">${esc(src.original_site)} ↗</a></li>` : ""}
        <li>Fetched: ${esc(fetched)} · <a href="${esc(src.api_url)}" target="_blank" rel="noopener">raw API data</a></li>
      </ul>
    </div>`;
}

function fitColor(fit) {
  if (fit >= 80) return "var(--good)";
  if (fit >= 60) return "var(--ok)";
  if (fit >= 45) return "var(--warn)";
  return "var(--none)";
}

const HOURS_RE = /(\d{1,2}(?:[.,]\d)?\s*(?:-|–|bis|to)?\s*(?:\d{1,2}(?:[.,]\d)?)?\s*-?\s*(?:Wochenstunden|Stunden|Std\.?|hours|h\b)(?:\s*(?:pro|\/|per|in der|die|a)\s*(?:Woche|week))?|\d\s*(?:-|bis)?\s*\d?\s*Tage\s*(?:pro|die|in der|\/)\s*Woche)/gi;

function highlightHours(html) {
  return html.replace(HOURS_RE, "<mark>$1</mark>");
}

function md(text) {
  let h = esc(text || "").replace(/\r/g, "");
  h = h.replace(/\\([*_#\-\[\]()])/g, "$1");
  h = h.replace(/^\s*#{1,6}\s*(.+)$/gm, "<h4>$1</h4>");
  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/^\s*[-•*·]\s+(.+)$/gm, "<li>$1</li>");
  h = h.replace(/(?:<li>.*<\/li>\n?)+/g, m => `<ul>${m.replace(/\n/g, "")}</ul>`);
  h = h.replace(/\n{2,}/g, "<br><br>").replace(/\n/g, "<br>");
  h = h.replace(/(<\/(?:h4|ul)>)(<br>)+/g, "$1");
  return highlightHours(h);
}

// ------------------------------------------------------------------ API --

const IS_LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const TRACKER_KEY = "wr-tracker";

async function fetchJobs(force = false) {
  const btn = $("#refreshBtn");
  btn.classList.add("loading");
  btn.disabled = true;
  if (!state.data) $("#jobList").innerHTML = '<div class="skeleton"></div>'.repeat(4);
  try {
    // Running locally (python3 app.py) → ask the server to fetch fresh listings first.
    if (force && IS_LOCAL) await fetch("api/refresh").catch(() => {});
    const res = await fetch(`data/jobs.json?v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const before = new Set((state.data?.jobs || []).map(j => j.id));
    const changed = state.data && state.data.updated_at !== data.updated_at;
    state.data = data;
    if (force) {
      const fresh = data.jobs.filter(j => !before.has(j.id)).length;
      if (fresh) toast(`✨ ${fresh} new listing${fresh > 1 ? "s" : ""}!`);
      else if (changed || IS_LOCAL) toast("Up to date, no new listings");
      else toast(`Listings update automatically 3× a day (last: ${timeAgo(data.updated_at)})`);
    }
  } catch (e) {
    toast("⚠️ Couldn't load the job list. Check your connection.");
    console.error(e);
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
    render();
  }
}

// Applications + notes live only in this browser (localStorage). Backup/restore via JSON file.
function fetchTracker() {
  try { state.tracker = JSON.parse(localStorage.getItem(TRACKER_KEY) || "{}"); }
  catch { state.tracker = {}; }
}

function persistTracker() {
  try {
    localStorage.setItem(TRACKER_KEY, JSON.stringify(state.tracker));
    return true;
  } catch {
    toast("⚠️ Couldn't save. Is private browsing on?");
    return false;
  }
}

function snapshot(job) {
  return {
    title: cleanTitle(job), company: job.company, city: job.city, url: job.url, fit: job.fit,
    hours_min: job.hours_min, hours_max: job.hours_max, hours_estimated: job.hours_estimated,
    emoji: job.emoji, category: job.category, minijob: job.minijob, full_time: job.full_time,
    is_student_job: job.is_student_job, source: job.source,
  };
}

async function updateTracker(id, patch) {
  const job = state.data?.jobs.find(j => j.id === id);
  const entry = { ...(state.tracker[id] || {}), ...patch, updated: new Date().toISOString() };
  if (job) entry.job = snapshot(job);
  if (!entry.status && !entry.note) delete state.tracker[id];
  else state.tracker[id] = entry;
  persistTracker();
}

function exportTracker() {
  const blob = new Blob([JSON.stringify(state.tracker, null, 1)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `werkstudent-radar-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("⬇️ Backup downloaded");
}

async function importTracker(file) {
  try {
    const data = JSON.parse(await file.text());
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("bad format");
    const n = Object.keys(data).length;
    if (!confirm(`Restore ${n} saved job${n === 1 ? "" : "s"}? This merges with what you have now.`)) return;
    for (const [id, entry] of Object.entries(data)) {
      const mine = state.tracker[id];
      if (!mine || (entry.updated || "") > (mine.updated || "")) state.tracker[id] = entry;
    }
    persistTracker();
    toast(`⬆️ Restored ${n} job${n === 1 ? "" : "s"}`);
    render();
  } catch {
    toast("⚠️ That file doesn't look like a Werkstudent Radar backup");
  }
}

async function setStatus(id, status) {
  const current = state.tracker[id]?.status;
  const next = current === status ? null : status;
  await updateTracker(id, { status: next });
  const msgs = { saved: "⭐ Saved", applied: "📨 Marked as applied. Good luck!", hidden: "🙈 Hidden",
                 interview: "💬 Interview! 🎉", offer: "🎉🎉🎉 Congrats!!", rejected: "Their loss. Onwards 💪" };
  toast(next ? msgs[next] : "Removed from your list");
  render();
}

// ------------------------------------------------------------ filtering --

function baseVisible(job) {
  const f = state.filters;
  const status = state.tracker[job.id]?.status;
  if (status === "hidden" && !f.showHidden) return false;
  if (!f.showOther && (job.dual_study || !job.is_student_job)) return false;
  if (job.fit < f.minFit) return false;
  if (job.distance_km != null && job.distance_km > (f.radius || 25)) return false;
  if (f.onlyNew && !isNew(job)) return false;
  if (f.hours !== "any") {
    if (job.hours_max == null) { if (!f.includeUnknown) return false; }
    else if (job.hours_max < Number(f.hours)) return false;
  } else if (!f.includeUnknown && job.hours_max == null) return false;
  if (f.q) {
    const hay = `${job.title} ${job.company} ${job.profession} ${job.category} ${job.city} ${job.description}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))) return false;
  }
  return true;
}

function visibleJobs() {
  if (!state.data) return [];
  const f = state.filters;
  let jobs = state.data.jobs.filter(baseVisible);
  if (f.cats.length) jobs = jobs.filter(j => f.cats.includes(j.category));
  const sorters = {
    fit: (a, b) => b.fit - a.fit,
    new: (a, b) => (b.published || "").localeCompare(a.published || "") || b.fit - a.fit,
    hours: (a, b) => hoursDistance(a) - hoursDistance(b) || b.fit - a.fit,
    dist: (a, b) => (a.distance_km ?? 99) - (b.distance_km ?? 99) || b.fit - a.fit,
  };
  return jobs.sort(sorters[f.sort] || sorters.fit);
}

// ------------------------------------------------------------- rendering --

function render() {
  renderHeader();
  renderStats();
  if (state.view === "discover") renderDiscover();
  if (state.view === "pipeline") renderPipeline();
  if (state.view === "boards") renderBoards();
  const tracked = Object.values(state.tracker).filter(t => PIPELINE_COLS.includes(t.status) || t.status === "rejected").length;
  $("#pipelineCount").textContent = tracked;
}

function renderHeader() {
  const d = state.data;
  $("#updated").textContent = d?.updated_at ? `Updated ${relDate(d.updated_at) === "today" ? timeAgo(d.updated_at) : relDate(d.updated_at)} · ${d.count} listings` : "";
}
function timeAgo(iso) {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)} h ago`;
}

function renderStats() {
  const jobs = state.data?.jobs || [];
  const students = jobs.filter(j => j.is_student_job && !j.dual_study && state.tracker[j.id]?.status !== "hidden");
  const top = students.filter(j => j.fit >= 70).length;
  const fresh = students.filter(j => isNew(j) && j.fit >= 45).length;
  const count = s => Object.values(state.tracker).filter(t => t.status === s).length;
  $("#stats").innerHTML = [
    [top, "🔥 top matches"],
    [fresh, "🆕 new this week"],
    [count("saved"), "⭐ saved"],
    [count("applied"), "📨 applied"],
    [count("interview") + count("offer"), "💬 interviews"],
  ].map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
}

function syncFilterInputs() {
  const f = state.filters;
  $("#q").value = f.q;
  $("#minFit").value = f.minFit;
  $("#minFitVal").textContent = f.minFit;
  $("#includeUnknown").checked = f.includeUnknown;
  $("#onlyNew").checked = f.onlyNew;
  $("#showOther").checked = f.showOther;
  $("#showHidden").checked = f.showHidden;
  $("#sort").value = f.sort;
  $("#radius").value = String(f.radius || 25);
  $$("#hoursSeg button").forEach(b => b.classList.toggle("active", b.dataset.hours === f.hours));
  $$("#layoutSeg button").forEach(b => b.classList.toggle("active", b.dataset.layout === f.layout));
}

function renderCategoryChips() {
  if (!state.data) return;
  const counts = {};
  state.data.jobs.filter(baseVisible).forEach(j => { counts[j.category] = (counts[j.category] || 0) + 1; });
  const emojis = Object.fromEntries(state.data.jobs.map(j => [j.category, j.emoji]));
  const cats = Object.keys({ ...counts, ...Object.fromEntries(state.filters.cats.map(c => [c, 0])) })
    .sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
  $("#catChips").innerHTML = cats.map(c => `
    <button class="chip ${state.filters.cats.includes(c) ? "active" : ""}" data-cat="${esc(c)}">
      ${emojis[c] || ""} ${esc(c)} <span class="n">${counts[c] || 0}</span>
    </button>`).join("") || '<span class="muted small">—</span>';
}

function renderDiscover() {
  syncFilterInputs();
  renderCategoryChips();
  if (!state.data) return;
  const jobs = visibleJobs();
  const total = state.data.jobs.length;
  $("#resultCount").textContent = `${jobs.length} match${jobs.length === 1 ? "" : "es"} out of ${total} listings`;

  const isMap = state.filters.layout === "map";
  $("#jobList").classList.toggle("hidden", isMap);
  $("#map").classList.toggle("hidden", !isMap);
  if (isMap) { renderMap(jobs); return; }

  if (!jobs.length) {
    $("#jobList").innerHTML = `<div class="empty"><span class="big">🫥</span>
      Nothing matches these filters.<br>Try lowering the minimum fit, allowing unknown hours, or check “More job boards”.</div>`;
    return;
  }
  $("#jobList").innerHTML = jobs.map(jobCard).join("");
}

function jobCard(job) {
  const t = state.tracker[job.id] || {};
  const h = hoursInfo(job);
  const open = state.expanded.has(job.id);
  const where = [job.district || job.city, job.distance_km != null ? `${job.distance_km} km` : null].filter(Boolean).join(" · ");
  const tags = [
    `<span class="tag ${h.cls}">${esc(h.text)}</span>`,
    `<span class="tag">${job.emoji} ${esc(job.category)}</span>`,
    job.homeoffice ? `<span class="tag">🏠 Home office</span>` : "",
    job.salary ? `<span class="tag">💰 ${esc(job.salary)}</span>` : "",
    job.dual_study ? `<span class="tag h-bad">Dual study</span>` : "",
    !job.is_student_job && !job.dual_study ? `<span class="tag h-warn">Not a student job</span>` : "",
    job.published ? `<span class="tag">📅 ${relDate(job.published)}</span>` : "",
  ].join("");
  const statusBadge = t.status && t.status !== "saved" && t.status !== "hidden"
    ? `<span class="badge-status">${STATUSES[t.status].label}</span>` : "";

  return `
  <article class="job ${t.status === "hidden" ? "is-hidden" : ""}" data-id="${esc(job.id)}">
    <div class="score" style="--p:${job.fit};--c:${fitColor(job.fit)}" title="Fit score: economics match, hours and whether it's a Werkstudent job">
      <span>${job.fit}<small>fit</small></span>
    </div>
    <div class="job-main">
      <div class="job-title">
        <h3><a href="${esc(job.url)}" target="_blank" rel="noopener">${esc(cleanTitle(job))}</a></h3>
        ${isNew(job) ? '<span class="badge-new">NEW</span>' : ""}${statusBadge}
      </div>
      <div class="company"><b>${esc(job.company)}</b>${where ? " · " + esc(where) : ""}</div>
      ${sourceLine(job.source)}
      <div class="tags">${tags}</div>
      ${job.hours_snippet ? `<div class="snippet">“…${highlightHours(esc(job.hours_snippet))}…”</div>` : ""}
      <div class="actions">
        <a class="btn" href="${esc(job.url)}" target="_blank" rel="noopener">Open on ${esc(job.source?.original_site || "arbeitsagentur.de")} ↗</a>
        <button class="btn ${t.status === "saved" ? "on-saved" : ""}" data-action="status" data-status="saved">${t.status === "saved" ? "★ Saved" : "☆ Save"}</button>
        <button class="btn ${["applied", "interview", "offer"].includes(t.status) ? "on-applied" : ""}" data-action="status" data-status="applied">${["applied", "interview", "offer"].includes(t.status) ? "✓ Applied" : "📨 Applied"}</button>
        <button class="btn btn-ghost" data-action="status" data-status="hidden">${t.status === "hidden" ? "Unhide" : "Hide"}</button>
        <span class="spacer"></span>
        <button class="btn btn-ghost" data-action="toggle">${open ? "▴ Less" : "▾ Details"}</button>
      </div>
      ${open ? details(job, t) : ""}
    </div>
  </article>`;
}

function details(job, t) {
  const pct = v => Math.round(v * 100);
  const s = job.scores;
  return `
    <div class="details">
      <div class="why">
        <span>📚 Economics match <b>${pct(s.econ)}%</b><span class="bar"><i style="width:${pct(s.econ)}%"></i></span></span>
        <span>⏱ Hours <b>${pct(s.hours)}%</b><span class="bar"><i style="width:${pct(s.hours)}%"></i></span></span>
        <span>🎓 Student job <b>${pct(s.student)}%</b><span class="bar"><i style="width:${pct(s.student)}%"></i></span></span>
      </div>
      <div class="why">
        ${job.profession ? `<span>🏷️ ${esc(job.profession)}</span>` : ""}
        ${job.start ? `<span>🚀 Start: ${esc(new Date(job.start).toLocaleDateString("de-DE"))}</span>` : ""}
        ${job.street ? `<span>📍 ${esc(job.street)}, ${esc(job.plz)} ${esc(job.city)}</span>` : ""}
      </div>
      ${sourceBlock(job.source)}
      <div class="desc">${md(job.description) || '<span class="muted">No description. Open the listing.</span>'}</div>
      <label class="note-label">📝 Your notes</label>
      <textarea data-action="note" placeholder="Contact person, deadline, what to mention in the cover letter…">${esc(t.note || "")}</textarea>
    </div>`;
}

function renderPipeline() {
  const entries = Object.entries(state.tracker).filter(([, t]) => t.status && t.status !== "hidden");
  const live = new Map((state.data?.jobs || []).map(j => [j.id, j]));
  const cols = [...PIPELINE_COLS, "rejected"];
  $("#pipeline").innerHTML = cols.map(col => {
    const items = entries.filter(([, t]) => t.status === col)
      .sort((a, b) => (b[1].updated || "").localeCompare(a[1].updated || ""));
    return `
      <div class="col">
        <h3><span>${STATUSES[col].label}</span><span class="muted">${items.length}</span></h3>
        <div class="col-items">
          ${items.map(([id, t]) => pipelineCard(id, t, live.get(id))).join("") ||
            `<div class="col-empty">${col === "saved" ? "Hit ☆ Save on a job to collect it here" : "Nothing yet"}</div>`}
        </div>
      </div>`;
  }).join("");
}

function pipelineCard(id, t, liveJob) {
  const j = liveJob ? snapshot(liveJob) : (t.job || { title: id });
  const h = hoursInfo(j);
  return `
    <div class="pcard" data-id="${esc(id)}">
      <a class="t" href="${esc(j.url || "#")}" target="_blank" rel="noopener">${j.emoji || ""} ${esc(j.title)}</a>
      <div class="c">${esc(j.company || "")}${j.fit != null ? ` · fit ${j.fit}` : ""} · <span class="tag ${h.cls}" style="font-size:11.5px">${esc(h.text)}</span></div>
      ${sourceLine(j.source)}
      ${liveJob ? "" : `<div class="gone">Listing is no longer online</div>`}
      <select data-action="pstatus">
        ${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === t.status ? "selected" : ""}>${v.label}</option>`).join("")}
        <option value="">🗑️ Remove</option>
      </select>
      <textarea data-action="note" placeholder="Notes…">${esc(t.note || "")}</textarea>
      <div class="muted small">Updated ${relDate(t.updated)}</div>
    </div>`;
}

function renderBoards() {
  $("#boards").innerHTML = BOARDS.map(b => b.group
    ? `<h2>${esc(b.group)}</h2>`
    : `<a class="board" href="${esc(b.url)}" target="_blank" rel="noopener">
        <div class="e">${b.e}</div><h3>${esc(b.name)} ↗</h3><p>${esc(b.d)}</p>
        ${b.tag ? `<span class="why-tag">${esc(b.tag)}</span>` : ""}
      </a>`).join("");
}

// ------------------------------------------------------------------ map --

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function renderMap(jobs) {
  try { await loadLeaflet(); } catch { $("#map").innerHTML = '<div class="empty">Map needs an internet connection.</div>'; return; }
  if (!state.map) {
    state.map = L.map("map").setView([51.0504, 13.7373], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18, attribution: "© OpenStreetMap",
    }).addTo(state.map);
  }
  setTimeout(() => state.map.invalidateSize(), 50);
  if (state.mapLayer) state.mapLayer.remove();
  state.mapLayer = L.layerGroup().addTo(state.map);
  const color = fit => fit >= 80 ? "#2f9e6b" : fit >= 60 ? "#3f8fb8" : fit >= 45 ? "#c98a12" : "#8a8f99";
  const placed = {};
  jobs.filter(j => j.lat && j.lon).forEach(j => {
    // nudge jobs at identical coordinates so they don't stack
    const key = `${j.lat.toFixed(4)},${j.lon.toFixed(4)}`;
    const n = placed[key] = (placed[key] || 0) + 1;
    const off = (n - 1) * 0.0004;
    const h = hoursInfo(j);
    L.circleMarker([j.lat + off, j.lon + off], {
      radius: 7 + j.fit / 15, color: "#fff", weight: 2, fillColor: color(j.fit), fillOpacity: 0.9,
    }).bindPopup(`<b>${esc(cleanTitle(j))}</b><br>${esc(j.company)}<br>
      Fit <b>${j.fit}</b> · ${esc(h.text)}<br>Source: ${esc(j.source?.original_site || "arbeitsagentur.de")}<br>
      <a href="${esc(j.url)}" target="_blank" rel="noopener">Open listing ↗</a>`)
      .addTo(state.mapLayer);
  });
}

// --------------------------------------------------------------- events --

function bindEvents() {
  $$(".tab").forEach(tab => tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    $$(".tab").forEach(t => t.classList.toggle("active", t === tab));
    $$(".view").forEach(v => v.classList.toggle("hidden", v.id !== `view-${state.view}`));
    render();
  }));

  $("#refreshBtn").addEventListener("click", () => fetchJobs(true));
  $("#filterToggle").addEventListener("click", () => $("#filters").classList.toggle("open"));

  const setF = (patch) => { Object.assign(state.filters, patch); saveFilters(); renderDiscover(); renderStats(); };
  let qTimer;
  $("#q").addEventListener("input", e => { clearTimeout(qTimer); qTimer = setTimeout(() => setF({ q: e.target.value }), 150); });
  $("#minFit").addEventListener("input", e => setF({ minFit: Number(e.target.value) }));
  $("#includeUnknown").addEventListener("change", e => setF({ includeUnknown: e.target.checked }));
  $("#onlyNew").addEventListener("change", e => setF({ onlyNew: e.target.checked }));
  $("#showOther").addEventListener("change", e => setF({ showOther: e.target.checked }));
  $("#showHidden").addEventListener("change", e => setF({ showHidden: e.target.checked }));
  $("#sort").addEventListener("change", e => setF({ sort: e.target.value }));
  $("#hoursSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setF({ hours: b.dataset.hours }); });
  $("#layoutSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setF({ layout: b.dataset.layout }); });
  $("#catChips").addEventListener("click", e => {
    const b = e.target.closest(".chip"); if (!b) return;
    const c = b.dataset.cat, cats = state.filters.cats;
    setF({ cats: cats.includes(c) ? cats.filter(x => x !== c) : [...cats, c] });
  });
  $("#radius").addEventListener("change", e => setF({ radius: Number(e.target.value) }));
  $("#resetFilters").addEventListener("click", () => {
    state.filters = { ...DEFAULT_FILTERS, layout: state.filters.layout };
    saveFilters(); renderDiscover(); renderStats();
  });

  // job cards (delegated)
  $("#jobList").addEventListener("click", e => {
    const el = e.target.closest("[data-action]");
    const card = e.target.closest(".job");
    if (!el || !card) return;
    const id = card.dataset.id;
    if (el.dataset.action === "status") setStatus(id, el.dataset.status);
    if (el.dataset.action === "toggle") {
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      renderDiscover();
    }
  });

  // notes: save when leaving the field (both views)
  document.addEventListener("focusout", async e => {
    if (e.target.dataset?.action !== "note") return;
    const id = e.target.closest("[data-id]")?.dataset.id;
    if (!id) return;
    const note = e.target.value.trim();
    if ((state.tracker[id]?.note || "") === note) return;
    await updateTracker(id, { note });
    toast("📝 Note saved");
    renderStats();
  });

  $("#exportBtn").addEventListener("click", exportTracker);
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", e => {
    if (e.target.files[0]) importTracker(e.target.files[0]);
    e.target.value = "";
  });

  $("#pipeline").addEventListener("change", async e => {
    if (e.target.dataset.action !== "pstatus") return;
    const id = e.target.closest("[data-id]").dataset.id;
    const status = e.target.value || null;
    await updateTracker(id, status ? { status } : { status: null, note: "" });
    if (status === "interview") toast("💬 Interview! You've got this 🎉");
    else if (status === "offer") toast("🎉🎉🎉 Congrats!!");
    render();
  });
}

// ----------------------------------------------------------------- boot --

(async function init() {
  bindEvents();
  syncFilterInputs();
  renderBoards();
  fetchTracker();
  await fetchJobs(false);
})();
