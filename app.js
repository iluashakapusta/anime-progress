"use strict";

const APP_VERSION = "1.3";

const SITE = "https://aniliberty.top";
const API = SITE + "/api/v1";
const DAY = 24 * 3600 * 1000;
const FRANCHISE_TTL = 7 * DAY, FINISHED_TTL = 7 * DAY, ONGOING_TTL = 3 * 3600 * 1000;

const COLLECTIONS = [
  ["WATCHING", "Смотрю"], ["WATCHED", "Просмотрено"], ["PLANNED", "Запланировано"],
  ["POSTPONED", "Отложено"], ["ABANDONED", "Брошено"],
];
const collectionTitle = (c) => (COLLECTIONS.find((x) => x[0] === c) || [, "Из истории"])[1];

// ---------- Storage ----------

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

const emptyCache = () => ({
  views: {},              // episodeId -> {r: releaseId, t: seconds, w: watched, u: updatedAt ms}
  historySyncedUntil: 0,
  collections: {},        // releaseId -> collection
  releases: {},           // releaseId -> {release, at}
  links: {},              // releaseId -> {f: franchiseId|null, at}
  franchises: {},         // franchiseId -> {id, name, releases: [{sort, id}]}
  hidden: [],
  lastSync: 0,
});

let token = store.get("token", null);
let nickname = store.get("nickname", null);
let cache = Object.assign(emptyCache(), store.get("cache", {}));

function saveCache() {
  if (!store.set("cache", cache)) {
    // Storage full: drop catalog data, it is re-downloaded on the next sync
    cache.releases = {};
    store.set("cache", cache);
  }
}

function deviceId() {
  let id = store.get("device_id", null);
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
    store.set("device_id", id);
  }
  return id;
}

// ---------- API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
class AuthError extends ApiError {
  constructor() { super(401, "Сессия истекла, войдите снова"); }
}

async function api(path, { method = "GET", query, body, auth = false } = {}) {
  const url = new URL(API + path);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    if (!token) throw new AuthError();
    headers.Authorization = "Bearer " + token;
  }
  let resp;
  try {
    resp = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Нет соединения с aniliberty.top");
  }
  const text = await resp.text();
  if (!resp.ok) {
    if (auth && (resp.status === 401 || resp.status === 403)) throw new AuthError();
    let msg = null;
    try { msg = JSON.parse(text).message; } catch {}
    if (!msg) msg = resp.status === 429 ? "Слишком много запросов, попробуйте через минуту"
      : resp.status >= 500 ? `Сервер AniLiberty не отвечает (${resp.status})` : `Ошибка запроса (${resp.status})`;
    throw new ApiError(resp.status, msg);
  }
  return text ? JSON.parse(text) : null;
}

const Api = {
  search: (q) => api("/app/search/releases", { query: { query: q } }),
  release: (id) => api(`/anime/releases/${id}`, { query: { exclude: "torrents,members,sponsors,genres" } }),
  franchises: (id) => api(`/anime/franchises/release/${id}`),
  login: (login, password) => api("/accounts/users/auth/login", { method: "POST", body: { login, password } }),
  otpGet: () => api("/accounts/otp/get", { method: "POST", body: { device_id: deviceId() } }),
  otpLogin: (code) => api("/accounts/otp/login", { method: "POST", body: { code: Number(code), device_id: deviceId() } }),
  logout: () => api("/accounts/users/auth/logout", { method: "POST", body: {}, auth: true }).catch(() => {}),
  profile: () => api("/accounts/users/me/profile", { auth: true }),
  history: (page) => api("/accounts/users/me/views/history", { query: { page, limit: 50 }, auth: true }),
  timecodes: () => api("/accounts/users/me/views/timecodes", { auth: true }),
  episode: (id) => api(`/anime/releases/episodes/${id}`),
  collectionIds: () => api("/accounts/users/me/collections/ids", { auth: true }),
  addToCollection: (id, c) => api("/accounts/users/me/collections", { method: "POST", body: [{ release_id: id, type_of_collection: c }], auth: true }),
  removeFromCollection: (id) => api("/accounts/users/me/collections", { method: "DELETE", body: [{ release_id: id }], auth: true }),
  async saveTimecodes(items) {
    for (let i = 0; i < items.length; i += 1000) {
      await api("/accounts/users/me/views/timecodes", { method: "POST", body: items.slice(i, i + 1000), auth: true });
    }
  },
};

const posterUrl = (r) => {
  const p = r && r.poster;
  if (!p) return null;
  const path = (p.optimized && p.optimized.preview) || p.preview || (p.optimized && p.optimized.src) || p.src;
  return path ? (path.startsWith("http") ? path : SITE + path) : null;
};
const episodeUrl = (id) => `${SITE}/anime/video/episode/${id}`;
const releaseUrl = (alias) => `${SITE}/anime/releases/release/${alias}`;

/** Keeps only the fields the app uses, so the cache fits in browser storage. */
function slimRelease(r) {
  return {
    id: r.id, alias: r.alias, year: r.year, name: { main: r.name?.main || "", english: r.name?.english || null },
    type: r.type ? { description: r.type.description } : null, poster: r.poster ? { optimized: { preview: r.poster.optimized?.preview }, preview: r.poster.preview, src: r.poster.src } : null,
    is_ongoing: !!r.is_ongoing, episodes_total: r.episodes_total ?? null,
    episodes: (r.episodes || []).map((e) => ({ id: e.id, ordinal: e.ordinal, name: e.name || null, duration: e.duration ?? null, sort_order: e.sort_order ?? 0 })),
  };
}

// ---------- Progress ----------

const sortedEpisodes = (r) => (r.episodes || []).slice().sort((a, b) => a.ordinal - b.ordinal || (a.sort_order || 0) - (b.sort_order || 0));

/**
 * The current position is the most recently touched episode. When that one is finished,
 * the position moves to the next episode, crossing into the next season if needed.
 */
function computePosition(seasons, views) {
  if (!seasons.length) return null;
  const flat = [];
  seasons.forEach((r, si) => {
    const eps = sortedEpisodes(r);
    eps.forEach((ep, ei) => flat.push({ si, release: r, ep, ei, size: eps.length }));
  });
  const total = flat.length;
  const watched = flat.filter((s) => views[s.ep.id]?.w).length;
  const make = (state, slot, time, activity) => ({
    state, season: slot.si + 1, seasonsTotal: seasons.length, release: slot.release, episode: slot.ep,
    episodeIndex: slot.ei + 1, episodesInSeason: slot.size, time, watched, total, activity,
  });

  let lastIdx = -1, lastAt = -1;
  flat.forEach((s, i) => { const v = views[s.ep.id]; if (v && v.u > lastAt) { lastAt = v.u; lastIdx = i; } });

  if (lastIdx < 0) {
    const first = flat[0];
    return first ? make("NOT_STARTED", first, 0, 0)
      : { state: "NOT_STARTED", season: 1, seasonsTotal: seasons.length, release: seasons[0], episode: null, episodeIndex: 1, episodesInSeason: 0, time: 0, watched: 0, total: 0, activity: 0 };
  }
  const last = flat[lastIdx];
  const lv = views[last.ep.id];
  if (!lv.w) return make("IN_PROGRESS", last, lv.t, lv.u);

  const next = flat[lastIdx + 1];
  if (next) {
    const nv = views[next.ep.id];
    // A next episode that was itself finished earlier (rewatching) restarts from zero.
    const time = nv && !nv.w ? nv.t : 0;
    return make(time > 0 ? "IN_PROGRESS" : "NEXT", next, time, lv.u);
  }
  const lastRelease = seasons[seasons.length - 1];
  const more = lastRelease.is_ongoing || (lastRelease.episodes_total != null && lastRelease.episodes_total > (lastRelease.episodes || []).length);
  return make(more ? "WAITING" : "COMPLETED", last, lv.t, lv.u);
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}
const fmtOrd = (o) => String(o);

function positionLine(p) {
  const ep = p.episode ? `Серия ${fmtOrd(p.episode.ordinal)} из ${p.episodesInSeason}` : "Серий пока нет";
  return p.seasonsTotal > 1 ? `Сезон ${p.season} из ${p.seasonsTotal} · ${ep}` : ep;
}
function stateLine(p) {
  const d = p.episode?.duration;
  switch (p.state) {
    case "NOT_STARTED": return "Ещё не начато";
    case "IN_PROGRESS": return d ? `Остановились на ${formatTime(p.time)} из ${formatTime(d)}` : `Остановились на ${formatTime(p.time)}`;
    case "NEXT": return "Предыдущая досмотрена, дальше эта серия";
    case "WAITING": return "Всё вышедшее просмотрено, ждём новые серии";
    default: return "Просмотрено полностью";
  }
}
const fraction = (p) => (p.state === "IN_PROGRESS" && p.episode?.duration ? Math.min(1, p.time / p.episode.duration) : null);
const canContinue = (p) => p && p.episode && p.state !== "COMPLETED" && p.state !== "WAITING";

// ---------- Titles ----------

const keyFor = (id) => (cache.links[id]?.f ? "f:" + cache.links[id].f : "r:" + id);

function seasonIds(id) {
  const fid = cache.links[id]?.f;
  const f = fid && cache.franchises[fid];
  if (!f || !f.releases.length) return [Number(id)];
  return f.releases.slice().sort((a, b) => a.sort - b.sort).map((x) => x.id);
}

function ownedIds() {
  const ids = new Set(Object.keys(cache.collections).map(Number));
  for (const v of Object.values(cache.views)) ids.add(v.r);
  return ids;
}

function buildEntries() {
  const groups = new Map();
  for (const id of ownedIds()) {
    const k = keyFor(id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(id);
  }
  const out = [];
  for (const [key, ids] of groups) {
    if (cache.hidden.includes(key)) continue;
    const seasons = seasonIds(ids[0]).map((id) => cache.releases[id]?.release).filter(Boolean);
    if (!seasons.length) continue;
    const position = computePosition(seasons, cache.views);
    const fid = cache.links[ids[0]]?.f;
    const franchise = fid && cache.franchises[fid];
    const current = position?.release || seasons[0];
    const collection = cache.collections[current.id] || ids.map((i) => cache.collections[i]).find(Boolean) || null;
    out.push({
      key, ids, seasons, position, collection,
      title: franchise && franchise.name && seasons.length > 1 ? franchise.name : current.name.main,
      poster: posterUrl(current) || posterUrl(seasons[0]),
    });
  }
  return out.sort((a, b) => (b.position?.activity || 0) - (a.position?.activity || 0) || a.title.localeCompare(b.title, "ru"));
}

let entries = buildEntries();

// ---------- Sync ----------

const sync = { running: false, step: null, error: null };

async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  });
  await Promise.all(workers);
}

async function runSync(full = false) {
  if (sync.running || !token) return;
  Object.assign(sync, { running: true, step: "Коллекции", error: null });
  render();
  try {
    const rows = await Api.collectionIds();
    const collections = {};
    for (const [id, type] of rows || []) if (COLLECTIONS.some((c) => c[0] === type)) collections[Math.trunc(id)] = type;
    cache.collections = collections;

    await syncHistory(full);
    await loadCatalog([...ownedIds()]);
    cache.lastSync = Date.now();
    saveCache();
    entries = buildEntries();
    Object.assign(sync, { running: false, step: null });
  } catch (e) {
    saveCache();
    entries = buildEntries();
    Object.assign(sync, { running: false, step: null, error: e.message });
    if (e instanceof AuthError) return sessionExpired();
  }
  render();
}

async function syncHistory(full) {
  const views = full ? {} : { ...cache.views };
  const since = full ? 0 : cache.historySyncedUntil;
  let newest = since;
  for (let page = 1; ; page++) {
    setStep(`История просмотров, стр. ${page}`);
    const resp = await Api.history(page);
    const data = resp?.data || [];
    let reachedKnown = false;
    for (const item of data) {
      const updated = Date.parse(item.updated_at) || 0;
      if (since > 0 && updated <= since) reachedKnown = true;
      const ep = item.release_episode;
      const releaseId = ep?.release_id ?? ep?.release?.id;
      if (releaseId == null) continue;
      const old = views[item.release_episode_id];
      if (!old || old.u <= updated) views[item.release_episode_id] = { r: releaseId, t: item.time || 0, w: !!item.is_watched, u: updated };
      if (updated > newest) newest = updated;
    }
    const pages = resp?.meta?.pagination?.total_pages || 1;
    if (reachedKnown || !data.length || page >= pages) break;
  }
  cache.views = views;
  cache.historySyncedUntil = newest;
  await syncTimecodes();
}

/**
 * The history list is rebuilt by a background job on the server and lags behind,
 * while the timecodes list changes as soon as the site's player saves. Take time and
 * "watched" from timecodes; history only tells which title an episode belongs to.
 */
async function syncTimecodes() {
  setStep("Таймкоды");
  const rows = await Api.timecodes();
  const now = Date.now();
  const unknown = [];
  for (const row of rows || []) {
    const [id, time, watched] = Array.isArray(row) ? row : [row?.release_episode_id, row?.time, row?.is_watched];
    if (typeof id !== "string") continue;
    const t = Number(time) || 0, w = !!watched;
    const v = cache.views[id];
    if (!v) { unknown.push({ id, t, w }); continue; }
    // Changed since history last saw it: this is the freshest activity
    if (Math.abs(v.t - t) >= 1 || v.w !== w) cache.views[id] = { ...v, t, w, u: Math.max(v.u, now) };
  }
  // Episodes history has not caught up with yet: look up their title directly
  await pool(unknown.slice(0, 40), 6, async ({ id, t, w }) => {
    try {
      const ep = await Api.episode(id);
      const releaseId = ep?.release_id ?? ep?.release?.id;
      if (releaseId != null) cache.views[id] = { r: releaseId, t, w, u: now };
    } catch {}
  });
}

async function loadCatalog(ids) {
  const now = Date.now();
  const stale = (link) => !link || now - link.at > FRANCHISE_TTL;
  const need = ids.filter((id) => stale(cache.links[id]));
  let done = 0;
  await pool(need, 6, async (id) => {
    if (!stale(cache.links[id])) { done++; return; } // filled by a sibling season meanwhile
    const list = await Api.franchises(id);
    const f = list && list[0];
    if (!f) cache.links[id] = { f: null, at: now };
    else {
      cache.franchises[f.id] = { id: f.id, name: f.name, releases: (f.franchise_releases || []).map((x) => ({ sort: x.sort_order, id: x.release_id })) };
      for (const x of f.franchise_releases || []) cache.links[x.release_id] = { f: f.id, at: now };
      cache.links[id] = { f: f.id, at: now };
    }
    setStep(`Сезоны: ${++done} из ${need.length}`);
  });

  const all = [...new Set(ids.flatMap(seasonIds))];
  const needRel = all.filter((id) => {
    const c = cache.releases[id];
    if (!c) return true;
    return now - c.at > (c.release.is_ongoing ? ONGOING_TTL : FINISHED_TTL);
  });
  done = 0;
  await pool(needRel, 6, async (id) => {
    try { cache.releases[id] = { release: slimRelease(await Api.release(id)), at: now }; } catch (e) { if (e instanceof AuthError) throw e; }
    setStep(`Серии: ${++done} из ${needRel.length}`);
  });
}

let stepTimer = null;
function setStep(text) {
  sync.step = text;
  if (!stepTimer) stepTimer = setTimeout(() => { stepTimer = null; if (view.name === "home") renderStatus(); }, 120);
}

// ---------- Actions ----------

async function act(done, fn) {
  try {
    await fn();
    saveCache();
    entries = buildEntries();
    render();
    toast(done);
  } catch (e) {
    if (e instanceof AuthError) return sessionExpired();
    toast("Не получилось: " + e.message);
  }
}

async function writeTimecodes(list) {
  // list: [{ep, releaseId, watched}]
  if (!list.length) return;
  await Api.saveTimecodes(list.map(({ ep, watched }) => ({ release_episode_id: ep.id, time: watched ? ep.duration || 0 : 0, is_watched: watched })));
  const base = Date.now();
  list.forEach(({ ep, releaseId, watched }, i) => {
    cache.views[ep.id] = { r: releaseId, t: watched ? ep.duration || 0 : 0, w: watched, u: base + i };
  });
}

function addRelease(release, collection, markAll) {
  return act(`«${release.name.main}» → ${collectionTitle(collection)}`, async () => {
    await Api.addToCollection(release.id, collection);
    cache.collections[release.id] = collection;
    await loadCatalog([release.id]);
    cache.hidden = cache.hidden.filter((k) => k !== keyFor(release.id));
    if (markAll) {
      const full = cache.releases[release.id]?.release || slimRelease(await Api.release(release.id));
      await writeTimecodes(sortedEpisodes(full).map((ep) => ({ ep, releaseId: full.id, watched: true })));
    }
  });
}

function setCollection(entry, collection) {
  return act(`Статус: ${collectionTitle(collection)}`, async () => {
    let ids = entry.ids.filter((id) => cache.collections[id]);
    if (!ids.length) ids = [entry.position?.release.id || entry.ids[0]];
    for (const id of ids) { await Api.addToCollection(id, collection); cache.collections[id] = collection; }
  });
}

function removeEntry(entry) {
  return act(`«${entry.title}» убран из списка`, async () => {
    for (const id of entry.ids.filter((i) => cache.collections[i])) {
      await Api.removeFromCollection(id);
      delete cache.collections[id];
    }
    cache.hidden.push(entry.key);
  });
}

function markWatchedUpTo(entry, episodeId) {
  return act("Отмечено как просмотренное", async () => {
    const flat = entry.seasons.flatMap((r) => sortedEpisodes(r).map((ep) => ({ ep, releaseId: r.id })));
    const upTo = flat.findIndex((x) => x.ep.id === episodeId);
    if (upTo < 0) return;
    const todo = flat.slice(0, upTo + 1).filter((x) => !cache.views[x.ep.id]?.w || x.ep.id === episodeId);
    await writeTimecodes(todo.map((x) => ({ ...x, watched: true })));
  });
}

function markUnwatched(episode, releaseId) {
  return act("Отметка снята", () => writeTimecodes([{ ep: episode, releaseId, watched: false }]));
}

// ---------- Session ----------

async function onToken(t) {
  token = t;
  store.set("token", t);
  try { const p = await Api.profile(); nickname = p.nickname || p.login || null; store.set("nickname", nickname); } catch {}
  login = { busy: false, error: null, otp: null };
  go("home");
  runSync();
}

function sessionExpired() {
  token = null;
  store.del("token");
  login = { busy: false, error: "Сессия истекла, войдите снова", otp: null };
  go("home");
}

async function logout() {
  await Api.logout();
  token = null; nickname = null;
  ["token", "nickname", "cache"].forEach(store.del);
  cache = emptyCache();
  entries = [];
  closeSheet();
  go("home");
}

// ---------- UI helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const appEl = $("#app"), sheetEl = $("#sheet"), toastEl = $("#toast");

const ICON = {
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  check: '<svg class="check" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-1.4 14.2-4.2-4.2 1.4-1.4 2.8 2.8 5.6-5.6 1.4 1.4z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5"/></svg>',
};

let toastTimer = null;
function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), 2600);
}

function poster(url, cls = "") {
  return `<div class="poster ${cls}" style="${url ? `background-image:url('${esc(url)}')` : ""}"></div>`;
}
const tag = (c) => `<span class="tag c-${c || "none"}">${esc(collectionTitle(c))}</span>`;
const meter = (f) => (f == null ? "" : `<div class="meter"><i style="width:${(f * 100).toFixed(1)}%"></i></div>`);

// ---------- Views ----------

let view = { name: "home" };
let filter = store.get("filter", "ALL");
let login = { busy: false, error: null, otp: null, tab: "password" };
let search = { q: "", loading: false, results: [], error: null };

function go(name, params = {}, push = true) {
  view = { name, ...params };
  if (push) history.pushState(view, "", name === "home" ? location.pathname : "#" + name);
  closeSheet();
  render();
  window.scrollTo(0, 0);
}
window.addEventListener("popstate", (e) => { view = e.state || { name: "home" }; closeSheet(); render(); });

function render() {
  if (!token) return renderLogin();
  if (view.name === "search") return renderSearch();
  if (view.name === "title") return renderTitle();
  renderHome();
}

function renderLogin() {
  const otp = login.otp;
  appEl.innerHTML = `
  <main><div class="login">
    <div>
      <h2>Аниме-прогресс</h2>
      <p class="muted" style="font-size:15px">Войдите в аккаунт AniLiberty. Приложение покажет, на каком сезоне, серии и минуте вы остановились, по вашей истории просмотров на сайте.</p>
    </div>
    <div class="seg" role="tablist">
      <button data-tab="password" class="${login.tab === "password" ? "on" : ""}">Логин и пароль</button>
      <button data-tab="otp" class="${login.tab === "otp" ? "on" : ""}">Код на сайте</button>
    </div>
    ${login.tab === "password" ? `
    <form id="pw" class="login" style="padding:0;gap:12px" autocomplete="on">
      <label class="field"><span class="muted">Логин или e-mail</span><input class="input" id="login" name="username" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" required value="${esc(login.user || "")}"></label>
      <label class="field"><span class="muted">Пароль</span><input class="input" id="password" name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn block" ${login.busy ? "disabled" : ""}>${login.busy ? "Вхожу…" : "Войти"}</button>
    </form>` : !otp ? `
      <p class="muted" style="font-size:15px;margin:0">Подходит, если вы входите на сайт через соцсети. Приложение получит код, а вы подтвердите его на сайте, где уже вошли в аккаунт.</p>
      <button class="btn block" id="otp-start" ${login.busy ? "disabled" : ""}>${login.busy ? "Получаю код…" : "Получить код"}</button>` : `
      <div class="muted" style="text-align:center">Ваш код</div>
      <div class="code">${esc(otp.code)}</div>
      <p style="text-align:center;margin:0">Откройте aniliberty.top там, где вы вошли в аккаунт, и введите этот код в разделе входа по коду. Приложение войдёт само, как только код будет подтверждён.</p>
      <div class="muted" style="text-align:center">Код действует ещё ${formatTime(otp.left)}</div>
      <a class="btn block" href="${SITE}" target="_blank" rel="noopener">Открыть aniliberty.top</a>
      <button class="btn ghost block" id="otp-cancel">Отмена</button>`}
    ${login.error ? `<div class="err">${esc(login.error)}</div>` : ""}
    <p class="muted">Неофициальное приложение. Логин и пароль отправляются только на aniliberty.top, на устройстве хранится лишь ключ сессии.</p>
  </div></main>`;

  appEl.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { stopOtp(); login = { ...login, tab: b.dataset.tab, error: null }; renderLogin(); });
  const pw = $("#pw");
  if (pw) pw.onsubmit = async (e) => {
    e.preventDefault();
    const l = $("#login").value.trim(), p = $("#password").value;
    login = { ...login, user: l, busy: true, error: null };
    renderLogin();
    try { onToken((await Api.login(l, p)).token); }
    catch (err) {
      login = { ...login, busy: false, error: err.status >= 400 && err.status < 500 ? "Неверный логин или пароль" : err.message };
      renderLogin();
    }
  };
  const start = $("#otp-start");
  if (start) start.onclick = startOtp;
  const cancel = $("#otp-cancel");
  if (cancel) cancel.onclick = () => { stopOtp(); login = { ...login, otp: null }; renderLogin(); };
}

let otpTimer = null;
function stopOtp() { clearInterval(otpTimer); otpTimer = null; }
async function startOtp() {
  login = { ...login, busy: true, error: null };
  renderLogin();
  let resp;
  try { resp = await Api.otpGet(); }
  catch (e) { login = { ...login, busy: false, error: e.message }; return renderLogin(); }
  login = { ...login, busy: false, otp: { code: resp.otp.code, left: resp.remaining_time || 300 } };
  renderLogin();
  let tick = 0;
  otpTimer = setInterval(async () => {
    if (!login.otp) return stopOtp();
    login.otp.left = Math.max(0, login.otp.left - 1);
    if (login.otp.left === 0) { stopOtp(); login = { ...login, otp: null, error: "Код истёк. Получите новый." }; return renderLogin(); }
    const c = $(".code + p + .muted");
    if (c) c.textContent = "Код действует ещё " + formatTime(login.otp.left);
    if (++tick % 3) return;
    try { const r = await Api.otpLogin(login.otp.code); if (r?.token) { stopOtp(); onToken(r.token); } } catch {}
  }, 1000);
}

function renderStatus() {
  const el = $("#status");
  if (!el) return;
  if (sync.running) {
    el.className = "status";
    el.innerHTML = `<div class="bar-progress indet"></div><span>${esc(sync.step || "Обновляю…")}</span>`;
  } else if (sync.error) {
    el.className = "status err";
    el.textContent = "Не удалось обновить: " + sync.error;
  } else {
    el.className = "status";
    el.innerHTML = "";
  }
}

function isStandalone() {
  return window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
}

function renderHome() {
  const counts = {};
  for (const e of entries) counts[e.collection || "HISTORY"] = (counts[e.collection || "HISTORY"] || 0) + 1;
  const shown = entries.filter((e) => filter === "ALL" || (filter === "HISTORY" ? !e.collection : e.collection === filter));
  const chips = [["ALL", `Все · ${entries.length}`]]
    .concat(COLLECTIONS.filter(([c]) => counts[c]).map(([c, t]) => [c, `${t} · ${counts[c]}`]))
    .concat(counts.HISTORY ? [["HISTORY", `Из истории · ${counts.HISTORY}`]] : []);
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const showInstall = ios && !isStandalone() && !store.get("install_hint_closed", false);

  appEl.innerHTML = `
  <header class="bar">
    <h1>Мой прогресс${nickname ? `<span class="sub">${esc(nickname)}</span>` : ""}</h1>
    <button class="icon-btn" id="refresh" aria-label="Обновить">${ICON.refresh}</button>
    <button class="icon-btn" id="to-search" aria-label="Найти и добавить">${ICON.search}</button>
    <button class="icon-btn" id="menu" aria-label="Меню">${ICON.more}</button>
  </header>
  <main>
    ${showInstall ? `<div class="hint"><div style="flex:1"><b>Добавьте на экран «Домой».</b> Нажмите «Поделиться» внизу Safari, затем «На экран "Домой"». Приложение будет открываться без адресной строки.</div><button class="icon-btn" id="hint-close" aria-label="Скрыть" style="width:28px;height:28px;color:var(--muted)">✕</button></div>` : ""}
    <div class="chips">${chips.map(([k, t]) => `<button class="chip ${filter === k ? "on" : ""}" data-filter="${k}">${esc(t)}</button>`).join("")}</div>
    <div id="status" class="status"></div>
    ${!entries.length && !sync.running ? `
      <div class="empty"><b>Список пуст</b><span>Сюда попадут тайтлы из ваших коллекций и истории просмотров на AniLiberty. Найдите аниме в каталоге и добавьте то, что уже посмотрели.</span><button class="btn" id="empty-search">Найти в каталоге</button></div>` : ""}
    <div class="list">${shown.map(cardHtml).join("")}</div>
  </main>`;
  renderStatus();

  $("#refresh").onclick = () => runSync();
  $("#to-search").onclick = () => go("search");
  $("#menu").onclick = openMenu;
  const es = $("#empty-search");
  if (es) es.onclick = () => go("search");
  const hc = $("#hint-close");
  if (hc) hc.onclick = () => { store.set("install_hint_closed", true); renderHome(); };
  appEl.querySelectorAll("[data-filter]").forEach((b) => b.onclick = () => { filter = b.dataset.filter; store.set("filter", filter); renderHome(); });
  appEl.querySelectorAll(".card").forEach((c) => c.onclick = (e) => {
    if (e.target.closest("a")) return;
    go("title", { key: c.dataset.key });
  });
}

function cardHtml(e) {
  const p = e.position;
  return `<div class="card" role="button" tabindex="0" data-key="${esc(e.key)}">
    ${poster(e.poster)}
    <div class="body">
      <div class="title">${esc(e.title)}</div>
      ${tag(e.collection)}
      ${p ? `
        <div class="pos">${esc(positionLine(p))}</div>
        <div class="muted">${esc(stateLine(p))}</div>
        ${meter(fraction(p))}
        <div class="row" style="margin-top:2px">
          <span class="muted grow">${p.watched} из ${p.total} серий</span>
          ${canContinue(p) ? `<a class="btn small" href="${episodeUrl(p.episode.id)}" target="_blank" rel="noopener">${ICON.play}${p.state === "NOT_STARTED" ? "Начать" : "Продолжить"}</a>` : ""}
        </div>` : ""}
    </div>
  </div>`;
}

function openMenu() {
  openSheet(`
    <div class="grab"></div>
    ${nickname ? `<div class="muted" style="padding:0 4px 6px">Аккаунт: ${esc(nickname)}</div>` : ""}
    <button class="opt" id="m-refresh">Обновить</button>
    <button class="opt" id="m-full">Перечитать всю историю</button>
    <button class="opt" id="m-logout" style="color:var(--danger)">Выйти из аккаунта</button>
    <div class="muted" style="padding:8px 4px 0">${cache.lastSync ? "Последнее обновление: " + new Date(cache.lastSync).toLocaleString("ru-RU") : ""}</div>
    <div class="muted" style="padding:2px 4px 0">Версия приложения ${APP_VERSION}</div>`);
  $("#m-refresh").onclick = () => { closeSheet(); runSync(); };
  $("#m-full").onclick = () => { closeSheet(); runSync(true); };
  $("#m-logout").onclick = logout;
}

function renderSearch() {
  appEl.innerHTML = `
  <header class="bar">
    <button class="icon-btn" id="back" aria-label="Назад">${ICON.back}</button>
    <input class="search-in" id="q" type="search" placeholder="Название аниме" value="${esc(search.q)}" autocomplete="off" enterkeyhint="search">
  </header>
  <main id="results"></main>`;
  $("#back").onclick = () => history.back();
  const q = $("#q");
  q.oninput = () => onQuery(q.value);
  setTimeout(() => q.focus(), 50);
  renderResults();
}

let searchTimer = null, searchSeq = 0;
function onQuery(value) {
  search.q = value;
  clearTimeout(searchTimer);
  if (value.trim().length < 2) { search = { q: value, loading: false, results: [], error: null }; return renderResults(); }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    search.loading = true; search.error = null; renderResults();
    try { const r = await Api.search(value.trim()); if (seq === searchSeq) search.results = r || []; }
    catch (e) { if (seq === searchSeq) search.error = "Поиск не удался: " + e.message; }
    if (seq === searchSeq) { search.loading = false; renderResults(); }
  }, 350);
}

function renderResults() {
  const el = $("#results");
  if (!el) return;
  let html = search.loading ? `<div class="bar-progress indet" style="margin-bottom:8px"></div>` : "";
  if (search.error) html += `<div class="err">${esc(search.error)}</div>`;
  if (!search.q.trim()) html += `<p class="muted">Ищите по русскому или английскому названию. Нажмите на тайтл, чтобы добавить его в коллекцию на AniLiberty.</p>`;
  else if (!search.loading && search.q.trim().length >= 2 && !search.results.length && !search.error) html += `<p class="muted">Ничего не нашлось</p>`;
  html += search.results.map((r) => {
    const meta = [r.year, r.type?.description, r.episodes_total ? r.episodes_total + " эп." : null, r.is_ongoing ? "выходит" : null].filter(Boolean).join(" · ");
    const c = cache.collections[r.id];
    return `<button class="res" data-id="${r.id}">
      ${poster(posterUrl(r), "sm")}
      <div class="body">
        <div class="title" style="font-size:15px">${esc(r.name.main)}</div>
        ${r.name.english ? `<div class="muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name.english)}</div>` : ""}
        <div class="muted">${esc(meta)}</div>
        ${c ? tag(c) : ""}
      </div></button>`;
  }).join("");
  el.innerHTML = html;
  el.querySelectorAll(".res").forEach((b) => b.onclick = () => openAddSheet(search.results.find((r) => r.id === Number(b.dataset.id))));
}

function openAddSheet(release) {
  const current = cache.collections[release.id] || null;
  let choice = current || "WATCHED";
  let markAll = !current;
  const draw = () => {
    openSheet(`
      <div class="grab"></div>
      <div class="title" style="font-size:19px">${esc(release.name.main)}</div>
      <div class="muted" style="margin-bottom:6px">Коллекция в аккаунте AniLiberty</div>
      ${COLLECTIONS.map(([c, t]) => `<button class="opt ${choice === c ? "on" : ""}" data-c="${c}"><span class="dot"></span>${t}</button>`).join("")}
      ${choice === "WATCHED" ? `<button class="opt ${markAll ? "on" : ""}" id="mark"><span class="box">${markAll ? "✓" : ""}</span><span>Отметить все серии просмотренными<br><span class="muted">Запишет отметки в историю просмотров на сайте</span></span></button>` : ""}
      <button class="btn block" id="add" style="margin-top:12px">${current ? "Сохранить" : "Добавить"}</button>`);
    sheetEl.querySelectorAll("[data-c]").forEach((b) => b.onclick = () => { choice = b.dataset.c; draw(); });
    const m = $("#mark");
    if (m) m.onclick = () => { markAll = !markAll; draw(); };
    $("#add").onclick = async () => {
      $("#add").disabled = true;
      $("#add").textContent = "Сохраняю…";
      await addRelease(release, choice, markAll && choice === "WATCHED");
      closeSheet();
      renderResults();
    };
  };
  draw();
}

function renderTitle() {
  const e = entries.find((x) => x.key === view.key);
  if (!e) {
    appEl.innerHTML = `<header class="bar"><button class="icon-btn" id="back" aria-label="Назад">${ICON.back}</button><h1></h1></header>
      <main><div class="empty">Тайтл убран из списка</div></main>`;
    $("#back").onclick = () => history.back();
    return;
  }
  const p = e.position;
  const cur = p?.episode?.id;
  const main = p?.release || e.seasons[0];
  appEl.innerHTML = `
  <header class="bar">
    <button class="icon-btn" id="back" aria-label="Назад">${ICON.back}</button>
    <h1 style="font-size:17px">${esc(e.title)}</h1>
  </header>
  <main>
    <div class="head">
      ${poster(e.poster, "lg")}
      <div class="body" style="gap:6px">
        <div class="title" style="font-size:19px;-webkit-line-clamp:3">${esc(e.title)}</div>
        ${p ? `<div class="pos">${esc(positionLine(p))}</div>
          ${p.seasonsTotal > 1 ? `<div class="muted">${esc(p.release.name.main)}</div>` : ""}
          <div class="muted">${esc(stateLine(p))}</div>
          ${meter(fraction(p))}
          <div class="muted">Просмотрено ${p.watched} из ${p.total} серий</div>` : ""}
      </div>
    </div>
    ${canContinue(p) ? `<a class="btn block" href="${episodeUrl(p.episode.id)}" target="_blank" rel="noopener">${ICON.play} Продолжить: серия ${fmtOrd(p.episode.ordinal)}${p.time > 0 ? " с " + formatTime(p.time) : ""}</a>` : ""}
    <div class="section">Коллекция</div>
    <div class="collections">${COLLECTIONS.map(([c, t]) => `<button class="chip ${e.collection === c ? "on" : ""}" data-set="${c}">${t}</button>`).join("")}</div>
    <div class="row" style="margin-top:10px">
      <a class="btn text" href="${releaseUrl(main.alias)}" target="_blank" rel="noopener">Страница на сайте</a>
      <button class="btn text danger" id="remove">Убрать из списка</button>
    </div>
    <div class="row">
      <button class="btn text" id="check">Проверить таймкод на сервере</button>
    </div>
    ${e.seasons.map((s, i) => `
      <div class="season"><b>${e.seasons.length > 1 ? `Сезон ${i + 1} · ` : ""}${esc(s.name.main)}</b>
        <span class="muted">${[s.year, s.type?.description, (s.episodes || []).length + " эп.", s.is_ongoing ? "выходит" : null].filter(Boolean).join(" · ")}</span></div>
      ${sortedEpisodes(s).map((ep) => episodeHtml(ep, s.id, ep.id === cur)).join("")}`).join("")}
  </main>`;

  $("#back").onclick = () => history.back();
  appEl.querySelectorAll("[data-set]").forEach((b) => b.onclick = () => setCollection(e, b.dataset.set));
  $("#remove").onclick = () => confirmRemove(e);
  $("#check").onclick = () => checkTimecode(e);
  appEl.querySelectorAll("[data-ep]").forEach((b) => b.onclick = () => {
    const [releaseId, epId] = b.dataset.ep.split("|");
    const season = e.seasons.find((s) => s.id === Number(releaseId));
    openEpisodeSheet(e, season, season.episodes.find((x) => x.id === epId));
  });
}

function episodeHtml(ep, releaseId, isCur) {
  const v = cache.views[ep.id];
  const d = ep.duration;
  const status = v?.w ? "Просмотрено"
    : v && v.t > 0 ? `Остановились на ${formatTime(v.t)}${d ? " из " + formatTime(d) : ""}` : d ? formatTime(d) : "";
  return `<div class="ep ${isCur ? "cur" : ""}">
    <span class="n">${esc(fmtOrd(ep.ordinal))}</span>
    <a href="${episodeUrl(ep.id)}" target="_blank" rel="noopener">
      <span class="name">${esc(ep.name || "Серия " + fmtOrd(ep.ordinal))}</span>
      ${status ? `<span class="muted">${esc(status)}</span>` : ""}
      ${v && !v.w && d && v.t > 0 ? meter(Math.min(1, v.t / d)) : ""}
    </a>
    ${v?.w ? ICON.check : ""}
    <button class="icon-btn" data-ep="${releaseId}|${esc(ep.id)}" aria-label="Действия с серией">${ICON.more}</button>
  </div>`;
}

function openEpisodeSheet(entry, season, ep) {
  const v = cache.views[ep.id];
  openSheet(`
    <div class="grab"></div>
    <div class="title" style="font-size:17px">Серия ${esc(fmtOrd(ep.ordinal))}${ep.name ? " · " + esc(ep.name) : ""}</div>
    <div class="muted" style="margin-bottom:6px">${esc(season.name.main)}</div>
    <button class="opt" id="e-upto">Просмотрено до этой серии</button>
    ${v ? `<button class="opt" id="e-unwatch">Снять отметку</button>` : ""}
    <a class="opt" href="${episodeUrl(ep.id)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">Открыть на сайте</a>`);
  $("#e-upto").onclick = () => { closeSheet(); markWatchedUpTo(entry, ep.id); };
  const u = $("#e-unwatch");
  if (u) u.onclick = () => { closeSheet(); markUnwatched(ep, season.id); };
}

/** Shows what the account stores for the current episode, straight from the server. */
async function checkTimecode(entry) {
  const ep = entry.position?.episode;
  if (!ep) return toast("В этом тайтле нет серий");
  openSheet(`<div class="grab"></div><div class="title" style="font-size:17px">Проверяю…</div><div class="bar-progress indet"></div>`);
  const fmtAt = (ms) => (ms ? new Date(ms).toLocaleString("ru-RU") : "—");
  let tc = "нет записи", hist = "нет записи", raw = "";
  try {
    const rows = await Api.timecodes();
    const row = (rows || []).find((r) => (Array.isArray(r) ? r[0] : r?.release_episode_id) === ep.id);
    if (row) {
      const [, t, w] = Array.isArray(row) ? row : [null, row.time, row.is_watched];
      tc = `${formatTime(t)}${w ? ", досмотрена" : ""}`;
    }
    raw = `Записей в списке таймкодов: ${(rows || []).length}`;
  } catch (e) {
    if (e instanceof AuthError) return sessionExpired();
    tc = "ошибка: " + e.message;
  }
  try {
    for (let page = 1; page <= 3; page++) {
      const resp = await Api.history(page);
      const it = (resp?.data || []).find((x) => x.release_episode_id === ep.id);
      if (it) { hist = `${formatTime(it.time)}${it.is_watched ? ", досмотрена" : ""}, обновлено ${fmtAt(Date.parse(it.updated_at))}`; break; }
      if (page >= (resp?.meta?.pagination?.total_pages || 1)) break;
    }
  } catch (e) { hist = "ошибка: " + e.message; }
  const mine = cache.views[ep.id];
  openSheet(`
    <div class="grab"></div>
    <div class="title" style="font-size:17px">Серия ${esc(fmtOrd(ep.ordinal))} · ${esc(entry.position.release.name.main)}</div>
    <div class="opt" style="display:grid;gap:2px"><span class="muted">Список таймкодов в аккаунте (обновляется сразу)</span><b>${esc(tc)}</b></div>
    <div class="opt" style="display:grid;gap:2px"><span class="muted">История просмотров в аккаунте</span><b>${esc(hist)}</b></div>
    <div class="opt" style="display:grid;gap:2px"><span class="muted">Что показывает приложение</span><b>${mine ? esc(formatTime(mine.t) + (mine.w ? ", досмотрена" : "")) : "нет данных"}</b></div>
    <div class="muted" style="padding:8px 4px 0">${esc(raw)} · Последнее обновление: ${esc(fmtAt(cache.lastSync))} · Версия ${APP_VERSION}</div>
    <button class="btn ghost block" id="c-close" style="margin-top:10px">Закрыть</button>`);
  $("#c-close").onclick = closeSheet;
}

function confirmRemove(entry) {
  openSheet(`
    <div class="grab"></div>
    <div class="title" style="font-size:18px">Убрать «${esc(entry.title)}» из списка?</div>
    <p class="muted" style="margin:4px 0 12px">Тайтл удалится из коллекций AniLiberty. История просмотров на сайте останется.</p>
    <button class="btn block" id="r-yes" style="background:var(--danger);color:#fff">Убрать</button>
    <button class="btn ghost block" id="r-no" style="margin-top:6px">Отмена</button>`);
  $("#r-no").onclick = closeSheet;
  $("#r-yes").onclick = async () => { closeSheet(); await removeEntry(entry); history.back(); };
}

function openSheet(html) {
  sheetEl.innerHTML = `<div class="sheet-back"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  $(".sheet-back", sheetEl).onclick = (e) => { if (e.target.classList.contains("sheet-back")) closeSheet(); };
}
function closeSheet() { sheetEl.innerHTML = ""; }

// ---------- Start ----------

history.replaceState({ name: "home" }, "", location.pathname);
render();
if (token) runSync();
// Catch up with what was watched on the site while the app was in the background
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token && Date.now() - cache.lastSync > 60 * 1000) runSync();
});
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
