import { pacificDateId } from "../../public/shared/pacific-time.js";

const EVENT_TTL_SECONDS = 60 * 60 * 24 * 180;
const MAX_DAYS = 31;
const MAX_LIST_PAGES_PER_DAY = 20;
const MAX_EVENTS_PER_DAY = 20000;

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

  const url = new URL(request.url);
  const endDate = url.searchParams.get("date") || pacificDateId();
  if (!isDateId(endDate)) {
    return json({ error: "Expected date as YYYY-MM-DD." }, 422);
  }

  const days = clampInt(url.searchParams.get("days"), 1, MAX_DAYS, 1);
  const sessionId = sanitizeSessionId(url.searchParams.get("sessionId") || "");
  const dates = Array.from({ length: days }, (_, index) => addDays(endDate, -index)).reverse();
  const summary = createSummary(dates);

  for (const date of dates) {
    await readDateEvents(env.ANALYTICS, date, (event) => {
      if (sessionId && event.sessionId !== sessionId) return;
      addEvent(summary, event);
    });
  }

  finishSummary(summary);
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

  return event;
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
    _sessions: new Set(),
  };
}

function addEvent(summary, event) {
  summary.eventCount += 1;
  increment(summary.byType, event.type);
  if (event.sessionId) summary._sessions.add(event.sessionId);
  if (event.kind) increment(summary.byKind, event.kind);
  if (event.mode) increment(summary.byMode, event.mode);

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

function finishSummary(summary) {
  summary.sessionCount = summary._sessions.size;
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...noStoreHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function noStoreHeaders() {
  return { "Cache-Control": "no-store" };
}
