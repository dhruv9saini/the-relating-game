import { pacificDateId } from "../../public/shared/pacific-time.js";

const EVENT_TTL_SECONDS = 60 * 60 * 24 * 180;
const MAX_DAYS = 31;
const MAX_LIST_PAGES_PER_DAY = 50;
const MAX_EVENTS_PER_DAY = 50000;
const MAX_RETURNED_EVENTS = 5000;
const MAX_RETURNED_SESSIONS = 1000;
const LOCAL_ADMIN_TOKEN = "local-dev-analytics-token";

const EVENT_TYPES = new Set([
  "app_ready",
  "puzzle_view",
  "guess",
  "game_end",
  "reset",
  "undo",
  "share",
]);
const KINDS = new Set(["daily", "random", "archive"]);
const MODES = new Set(["easy", "hard"]);
const OUTCOMES = new Set(["accepted", "rejected"]);
const RESULTS = new Set(["won", "lost", "gave-up"]);
const REASONS = new Set([
  "invalid_shape",
  "missing_dictionary",
  "repeat_current",
  "duplicate_path",
  "too_far",
  "score_error",
]);

export async function onRequestPost({ request, env }) {
  if (!env.ANALYTICS) {
    return json({ error: "Analytics storage is not configured." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON request body." }, 400);
  }

  const now = new Date();
  const event = sanitizeEvent(body, now);
  if (!event) {
    return json({ error: "Analytics event is not valid." }, 422);
  }
  await addRequestMetadata(event, request, env);

  const key = `analytics:${event.date}:${now.getTime().toString(36)}:${crypto.randomUUID()}`;
  await env.ANALYTICS.put(key, JSON.stringify(event), {
    expirationTtl: EVENT_TTL_SECONDS,
  });
  return new Response(null, { status: 204, headers: noStoreHeaders() });
}

export async function onRequestGet({ request, env }) {
  if (!env.ANALYTICS) {
    return json({ error: "Analytics storage is not configured." }, 500);
  }
  if (!canReadAnalytics(request, env)) {
    return json(
      { error: "Analytics are private. Send Authorization: Bearer <owner token>." },
      401,
      { "WWW-Authenticate": 'Bearer realm="analytics"' },
    );
  }

  const url = new URL(request.url);
  const endDate = url.searchParams.get("date") || pacificDateId();
  if (!isDateId(endDate)) {
    return json({ error: "Expected date as YYYY-MM-DD." }, 422);
  }

  const days = clampInt(url.searchParams.get("days"), 1, MAX_DAYS, 1);
  const sessionId = sanitizeSessionId(url.searchParams.get("sessionId") || "");
  const includeEvents = url.searchParams.get("includeEvents") === "1";
  const limit = clampInt(url.searchParams.get("limit"), 1, MAX_RETURNED_EVENTS, 500);
  const dates = Array.from({ length: days }, (_, index) => addDays(endDate, -index)).reverse();
  const summary = createSummary(dates);
  const events = [];

  for (const date of dates) {
    await readDateEvents(env.ANALYTICS, date, (event) => {
      if (sessionId && event.sessionId !== sessionId) return;
      addEvent(summary, event);
      if (includeEvents) events.push(event);
    });
  }

  finishSummary(summary);
  if (includeEvents) {
    summary.events = events
      .sort((left, right) => String(right.at).localeCompare(String(left.at)))
      .slice(0, limit);
  }
  return json(summary);
}

function sanitizeEvent(value, now) {
  if (!value || typeof value !== "object") return null;
  const type = sanitizeEnum(value.type, EVENT_TYPES);
  if (!type) return null;

  const event = {
    type,
    date: pacificDateId(now),
    at: now.toISOString(),
  };

  const sessionId = sanitizeSessionId(value.sessionId);
  if (sessionId) event.sessionId = sessionId;

  copyEnum(event, value, "kind", KINDS);
  copyEnum(event, value, "mode", MODES);
  copyDate(event, value, "puzzleDate");
  copyInt(event, value, "stepCount", 0, 10);
  copyInt(event, value, "pathLength", 1, 11);
  copyInt(event, value, "loadMs", 0, 120000);
  copyInt(event, value, "viewportWidth", 1, 10000);
  copyInt(event, value, "viewportHeight", 1, 10000);
  copyInt(event, value, "screenWidth", 1, 10000);
  copyInt(event, value, "screenHeight", 1, 10000);
  copyInt(event, value, "timezoneOffset", -1440, 1440);
  copyNumber(event, value, "gap", 0, 2);
  copyNumber(event, value, "stepGap", 0, 2);
  copyNumber(event, value, "targetGap", 0, 2);
  copyBoolean(event, value, "resumed");
  copyBoolean(event, value, "done");
  copyBoolean(event, value, "hasEasySolution");
  copyBoolean(event, value, "hasHardSolution");
  copyEnum(event, value, "outcome", OUTCOMES);
  copyEnum(event, value, "result", RESULTS);
  copyEnum(event, value, "reason", REASONS);
  copyString(event, value, "pagePath", 300);
  copyString(event, value, "language", 40);
  copyString(event, value, "timeZone", 80);
  copyWord(event, value, "startWord");
  copyWord(event, value, "targetWord");
  copyWord(event, value, "currentWord");
  copyWord(event, value, "previousWord");
  copyWord(event, value, "submittedWord");
  copyPath(event, value, "path");

  return event;
}

async function addRequestMetadata(event, request, env) {
  copyHeader(event, request, "userAgent", "user-agent", 300);
  copyHeader(event, request, "referrer", "referer", 500);

  const cf = request.cf || {};
  copyCf(event, cf, "country", 80);
  copyCf(event, cf, "region", 120);
  copyCf(event, cf, "city", 120);
  copyCf(event, cf, "timezone", 120);
  copyCf(event, cf, "colo", 20);
  if (Number.isInteger(cf.asn)) event.asn = cf.asn;
  copyCf(event, cf, "asOrganization", 160);

  const ip = request.headers.get("cf-connecting-ip");
  if (ip) {
    event.ipHash = await sha256Hex(`${env.ANALYTICS_ADMIN_TOKEN || LOCAL_ADMIN_TOKEN}:${ip}`, 20);
  }
}

async function readDateEvents(namespace, date, onEvent) {
  let cursor;
  let pages = 0;
  let events = 0;

  do {
    const page = await namespace.list({
      prefix: `analytics:${date}:`,
      cursor,
      limit: 1000,
    });
    pages += 1;
    cursor = page.cursor;

    const keys = page.keys.map((key) => key.name);
    for (let index = 0; index < keys.length; index += 100) {
      const chunk = keys.slice(index, index + 100);
      const values = await namespace.get(chunk, { type: "json" });
      for (const key of chunk) {
        const event = values.get(key);
        if (event && typeof event === "object") {
          onEvent(event);
          events += 1;
          if (events >= MAX_EVENTS_PER_DAY) return;
        }
      }
    }

    if (page.list_complete || pages >= MAX_LIST_PAGES_PER_DAY) return;
  } while (cursor);
}

function createSummary(dates) {
  return {
    dates,
    eventCount: 0,
    sessionCount: 0,
    byType: {},
    byKind: {},
    byMode: {},
    byCountry: {},
    byPage: {},
    byReferrer: {},
    devices: {
      mobile: 0,
      tablet: 0,
      desktop: 0,
      unknown: 0,
    },
    words: {
      submitted: {},
      starts: {},
      targets: {},
    },
    guesses: {
      total: 0,
      accepted: 0,
      rejected: 0,
      byReason: {},
    },
    games: {
      total: 0,
      won: 0,
      lost: 0,
      gaveUp: 0,
      totalSteps: 0,
      averageSteps: null,
    },
    puzzleViews: {
      total: 0,
      resumed: 0,
      completed: 0,
      withHardSolution: 0,
    },
    shares: 0,
    appReady: {
      total: 0,
      averageLoadMs: null,
      totalLoadMs: 0,
    },
    sessions: [],
    _sessions: new Map(),
  };
}

function addEvent(summary, event) {
  summary.eventCount += 1;
  increment(summary.byType, event.type);
  if (event.kind) increment(summary.byKind, event.kind);
  if (event.mode) increment(summary.byMode, event.mode);
  if (event.country) increment(summary.byCountry, event.country);
  if (event.pagePath) increment(summary.byPage, event.pagePath);
  if (event.referrer) increment(summary.byReferrer, event.referrer);
  increment(summary.devices, deviceClass(event));
  if (event.startWord) increment(summary.words.starts, event.startWord);
  if (event.targetWord) increment(summary.words.targets, event.targetWord);
  if (event.submittedWord) increment(summary.words.submitted, event.submittedWord);
  addSessionEvent(summary, event);

  if (event.type === "app_ready") {
    summary.appReady.total += 1;
    if (Number.isFinite(event.loadMs)) summary.appReady.totalLoadMs += event.loadMs;
  }

  if (event.type === "puzzle_view") {
    summary.puzzleViews.total += 1;
    if (event.resumed) summary.puzzleViews.resumed += 1;
    if (event.done) summary.puzzleViews.completed += 1;
    if (event.hasHardSolution) summary.puzzleViews.withHardSolution += 1;
  }

  if (event.type === "guess") {
    summary.guesses.total += 1;
    if (event.outcome === "accepted") summary.guesses.accepted += 1;
    if (event.outcome === "rejected") summary.guesses.rejected += 1;
    if (event.reason) increment(summary.guesses.byReason, event.reason);
  }

  if (event.type === "game_end") {
    summary.games.total += 1;
    if (event.result === "won") summary.games.won += 1;
    if (event.result === "lost") summary.games.lost += 1;
    if (event.result === "gave-up") summary.games.gaveUp += 1;
    if (Number.isFinite(event.stepCount)) summary.games.totalSteps += event.stepCount;
  }

  if (event.type === "share") {
    summary.shares += 1;
  }
}

function addSessionEvent(summary, event) {
  if (!event.sessionId) return;
  let session = summary._sessions.get(event.sessionId);
  if (!session) {
    session = {
      sessionId: event.sessionId,
      firstAt: event.at,
      lastAt: event.at,
      eventCount: 0,
      byType: {},
      kind: event.kind || "",
      mode: event.mode || "",
      country: event.country || "",
      region: event.region || "",
      city: event.city || "",
      ipHash: event.ipHash || "",
      userAgent: event.userAgent || "",
      referrer: event.referrer || "",
      pagePath: event.pagePath || "",
      guesses: { total: 0, accepted: 0, rejected: 0 },
      games: { total: 0, won: 0, lost: 0, gaveUp: 0 },
      lastPath: [],
      lastEvent: "",
    };
    summary._sessions.set(event.sessionId, session);
  }

  if (String(event.at) < String(session.firstAt)) session.firstAt = event.at;
  if (String(event.at) > String(session.lastAt)) session.lastAt = event.at;
  session.eventCount += 1;
  session.lastEvent = event.type;
  increment(session.byType, event.type);
  if (event.kind) session.kind = event.kind;
  if (event.mode) session.mode = event.mode;
  if (event.country) session.country = event.country;
  if (event.region) session.region = event.region;
  if (event.city) session.city = event.city;
  if (event.ipHash) session.ipHash = event.ipHash;
  if (event.userAgent) session.userAgent = event.userAgent;
  if (event.referrer) session.referrer = event.referrer;
  if (event.pagePath) session.pagePath = event.pagePath;
  if (Array.isArray(event.path)) session.lastPath = event.path;

  if (event.type === "guess") {
    session.guesses.total += 1;
    if (event.outcome === "accepted") session.guesses.accepted += 1;
    if (event.outcome === "rejected") session.guesses.rejected += 1;
  }
  if (event.type === "game_end") {
    session.games.total += 1;
    if (event.result === "won") session.games.won += 1;
    if (event.result === "lost") session.games.lost += 1;
    if (event.result === "gave-up") session.games.gaveUp += 1;
  }
}

function finishSummary(summary) {
  summary.sessionCount = summary._sessions.size;
  summary.sessions = [...summary._sessions.values()]
    .sort((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)))
    .slice(0, MAX_RETURNED_SESSIONS);
  delete summary._sessions;
  if (summary.games.total > 0) {
    summary.games.averageSteps = round(summary.games.totalSteps / summary.games.total);
  }
  if (summary.appReady.total > 0) {
    summary.appReady.averageLoadMs = Math.round(
      summary.appReady.totalLoadMs / summary.appReady.total,
    );
  }
}

function deviceClass(event) {
  if (!Number.isFinite(event.viewportWidth)) return "unknown";
  if (event.viewportWidth < 700) return "mobile";
  if (event.viewportWidth < 1100) return "tablet";
  return "desktop";
}

function canReadAnalytics(request, env) {
  const expected = env.ANALYTICS_ADMIN_TOKEN || localAdminToken(request);
  if (!expected) return false;
  const token = readBearerToken(request) || request.headers.get("x-analytics-token") || "";
  return secureCompare(token, expected);
}

function localAdminToken(request) {
  const hostname = new URL(request.url).hostname;
  return ["127.0.0.1", "localhost", "::1"].includes(hostname) ? LOCAL_ADMIN_TOKEN : "";
}

function readBearerToken(request) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function secureCompare(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function sanitizeSessionId(value) {
  if (typeof value !== "string") return "";
  return /^[a-z0-9-]{8,64}$/i.test(value) ? value : "";
}

function sanitizeEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : "";
}

function sanitizeString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
}

function sanitizeWord(value) {
  const word = sanitizeString(value, 15).toLowerCase();
  return /^[a-z]{2,15}$/.test(word) ? word : "";
}

function copyEnum(event, source, key, allowed) {
  const value = sanitizeEnum(source[key], allowed);
  if (value) event[key] = value;
}

function copyDate(event, source, key) {
  if (isDateId(source[key])) event[key] = source[key];
}

function copyBoolean(event, source, key) {
  if (typeof source[key] === "boolean") event[key] = source[key];
}

function copyInt(event, source, key, min, max) {
  const value = Number(source[key]);
  if (Number.isInteger(value) && value >= min && value <= max) event[key] = value;
}

function copyNumber(event, source, key, min, max) {
  const value = Number(source[key]);
  if (Number.isFinite(value) && value >= min && value <= max) event[key] = round(value);
}

function copyString(event, source, key, maxLength) {
  const value = sanitizeString(source[key], maxLength);
  if (value) event[key] = value;
}

function copyWord(event, source, key) {
  const value = sanitizeWord(source[key]);
  if (value) event[key] = value;
}

function copyPath(event, source, key) {
  if (!Array.isArray(source[key])) return;
  const path = source[key].map(sanitizeWord).filter(Boolean).slice(0, 11);
  if (path.length > 0) event[key] = path;
}

function copyHeader(event, request, eventKey, headerKey, maxLength) {
  const value = sanitizeString(request.headers.get(headerKey) || "", maxLength);
  if (value) event[eventKey] = value;
}

function copyCf(event, cf, key, maxLength) {
  const value = sanitizeString(cf?.[key], maxLength);
  if (value) event[key] = value;
}

async function sha256Hex(input, length = 64) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function isDateId(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(dateId, amount) {
  const [year, month, day] = dateId.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + amount);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...noStoreHeaders(),
      ...headers,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function noStoreHeaders() {
  return { "Cache-Control": "no-store" };
}
