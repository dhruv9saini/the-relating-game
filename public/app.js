import { pacificDateId } from "./shared/pacific-time.js";

const DICTIONARY_URL = "./data/dictionary.txt";
const BLOCKED_WORDS_URL = "./data/blocked-words.json";
const ENDPOINTS_URL = "./data/endpoints.json";
const LEXICON_URL = "./data/lexicon.json";
const MANIFEST_URL = "./data/manifest.json";
const PUZZLE_API_URL = "./api/puzzle";
const EMBED_API_URL = "./api/embed";
const ANALYTICS_API_URL = "./api/analytics";
const STORAGE_KEY = "the-relating-game:v3";
const ANALYTICS_SESSION_KEY = "the-relating-game:analytics-session";
const SHARE_SITE = "relating-game.pages.dev";
const START_DATE = "2026-06-10";
const MAX_STEPS = 10;

const MODES = {
  easy: { label: "Easy", gapDivisor: 1.5 },
  hard: { label: "Hard", gapDivisor: 2 },
};

const TARGET_PAIR_GAP = 0.9;
const MIN_PAIR_GAP = 0.86;
const MAX_PAIR_GAP = 0.94;
const TEST_PARAMS = new URLSearchParams(window.location.search);
const USE_MOCK_MODEL = TEST_PARAMS.has("mockModel");
const DISABLE_ANALYTICS = TEST_PARAMS.has("noAnalytics");
const appStartedAt = performance.now();

const elements = {
  bootScreen: document.querySelector("#bootScreen"),
  bootCard: document.querySelector(".boot-card"),
  bootProgress: document.querySelector("#bootProgress"),
  bootText: document.querySelector("#bootText"),
  modelStatus: document.querySelector("#modelStatus"),
  kindButtons: [...document.querySelectorAll("[data-kind]")],
  modeButtons: [...document.querySelectorAll("[data-mode]")],
  dateControls: document.querySelector("#dateControls"),
  archiveDate: document.querySelector("#archiveDate"),
  previousDay: document.querySelector("#previousDay"),
  nextDay: document.querySelector("#nextDay"),
  newRandom: document.querySelector("#newRandom"),
  currentWordLabel: document.querySelector("#currentWordLabel"),
  startWord: document.querySelector("#startWord"),
  targetWord: document.querySelector("#targetWord"),
  puzzleSummary: document.querySelector("#puzzleSummary"),
  targetGap: document.querySelector("#targetGap"),
  targetGapBar: document.querySelector("#targetGapBar"),
  limitMarker: document.querySelector("#limitMarker"),
  pathChips: document.querySelector("#pathChips"),
  guessForm: document.querySelector("#guessForm"),
  guessInput: document.querySelector("#guessInput"),
  submitGuess: document.querySelector("#submitGuess"),
  message: document.querySelector("#message"),
  puzzleLabel: document.querySelector("#puzzleLabel"),
  startGapLabel: document.querySelector("#startGapLabel"),
  limitLabel: document.querySelector("#limitLabel"),
  stepLabel: document.querySelector("#stepLabel"),
  pathList: document.querySelector("#pathList"),
  undoStep: document.querySelector("#undoStep"),
  resetGame: document.querySelector("#resetGame"),
  giveUp: document.querySelector("#giveUp"),
  shareResult: document.querySelector("#shareResult"),
  shareRow: document.querySelector("#shareRow"),
  shareText: document.querySelector("#shareText"),
  copyShare: document.querySelector("#copyShare"),
  solutionSection: document.querySelector("#solutionSection"),
  solutionStatus: document.querySelector("#solutionStatus"),
  solutionPathList: document.querySelector("#solutionPathList"),
  playedStat: document.querySelector("#playedStat"),
  winsStat: document.querySelector("#winsStat"),
  bestStat: document.querySelector("#bestStat"),
  avgStat: document.querySelector("#avgStat"),
  resultPanel: document.querySelector("#resultPanel"),
  resultTitle: document.querySelector("#resultTitle"),
  resultText: document.querySelector("#resultText"),
  resultSolution: document.querySelector("#resultSolution"),
};

let dictionary = new Set();
let blockedWords = new Set();
let endpoints = [];
let manifest = null;
let vectorWords = new Map();
let vectorWordList = [];
let vectorShards = [];
let vectorShardPaths = [];
let vectorDim = 0;
let vectorShardSize = 0;
let vectorShardsLoaded = false;
let vectorShardLoadPromise = null;
let vectorCache = new Map();
let currentPuzzle = null;
let currentRecord = null;
let targetGapRequest = 0;
let hardPathCache = new Map();

const defaultStorage = {
  mode: "easy",
  kind: "daily",
  archiveDate: previousDateId(todayId()),
  randomSeed: "",
  games: {},
  stats: {
    easy: { played: 0, wins: 0, totalSteps: 0, best: null },
    hard: { played: 0, wins: 0, totalSteps: 0, best: null },
  },
};

let storage = loadStorage();

function loadStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return mergeStorage(defaultStorage, parsed || {});
  } catch {
    return structuredClone(defaultStorage);
  }
}

function mergeStorage(base, value) {
  const merged = structuredClone(base);
  if (typeof value.mode === "string" && MODES[value.mode]) merged.mode = value.mode;
  if (["daily", "random", "archive"].includes(value.kind)) merged.kind = value.kind;
  if (isDateId(value.archiveDate)) merged.archiveDate = value.archiveDate;
  if (typeof value.randomSeed === "string") merged.randomSeed = value.randomSeed;
  if (value.games && typeof value.games === "object") merged.games = value.games;
  for (const mode of Object.keys(MODES)) {
    if (value.stats?.[mode]) {
      merged.stats[mode] = {
        ...merged.stats[mode],
        ...value.stats[mode],
      };
    }
  }
  return merged;
}

function saveStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(storage));
}

function analyticsSessionId() {
  try {
    let id = sessionStorage.getItem(ANALYTICS_SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(ANALYTICS_SESSION_KEY, id);
    }
    return id;
  } catch {
    return "";
  }
}

function analyticsContext(details = {}) {
  const steps = currentRecord ? Math.max(0, currentRecord.path.length - 1) : 0;
  return {
    sessionId: analyticsSessionId(),
    kind: currentPuzzle?.kind || storage.kind,
    mode: storage.mode,
    puzzleDate: currentPuzzle?.date || "",
    stepCount: steps,
    pathLength: currentRecord?.path.length || 0,
    gap: currentPuzzle?.gap,
    done: Boolean(currentRecord?.done),
    ...details,
  };
}

function trackEvent(type, details = {}) {
  if (DISABLE_ANALYTICS) return;

  const body = JSON.stringify({
    type,
    ...analyticsContext(details),
  });

  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(ANALYTICS_API_URL, blob)) return;
  }

  fetch(ANALYTICS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: body.length < 60000,
  }).catch(() => {});
}

function trackPuzzleView() {
  trackEvent("puzzle_view", {
    resumed: Boolean(currentRecord && currentRecord.path.length > 1),
    hasEasySolution: Boolean(getCachedRelateBotSolution("easy")),
    hasHardSolution: Boolean(getCachedRelateBotSolution("hard")),
  });
}

function applyStartupRoute() {
  const requestedKind = TEST_PARAMS.get("kind");
  if (["daily", "random", "archive"].includes(requestedKind)) {
    storage.kind = requestedKind;
    if (requestedKind === "archive") {
      storage.archiveDate = clampDate(TEST_PARAMS.get("date") || storage.archiveDate);
    }
    if (requestedKind === "random") {
      storage.randomSeed = TEST_PARAMS.get("seed") || storage.randomSeed || createRandomSeed();
    }
    saveStorage();
    return;
  }

  if (window.location.pathname === "/" || window.location.pathname.endsWith("/index.html")) {
    storage.kind = "daily";
    saveStorage();
  }
}

function setBootProgress(value, text, tone = "") {
  elements.bootScreen.hidden = false;
  elements.bootScreen.setAttribute("aria-busy", tone === "error" ? "false" : "true");
  elements.bootCard.classList.toggle("error", tone === "error");
  document.body.classList.add("is-loading");
  if (Number.isFinite(value)) {
    elements.bootProgress.max = 100;
    elements.bootProgress.value = Math.max(0, Math.min(100, value));
  } else {
    elements.bootProgress.removeAttribute("value");
  }
  elements.bootText.textContent = text;
}

function hideBoot() {
  elements.bootProgress.value = 100;
  elements.bootText.textContent = "Ready.";
  elements.bootScreen.hidden = true;
  elements.bootScreen.setAttribute("aria-busy", "false");
  elements.bootCard.classList.remove("error");
  document.body.classList.remove("is-loading");
}

function showBootError(text) {
  setBootProgress(null, text, "error");
}

function setStatus(text, tone = "") {
  elements.modelStatus.textContent = text;
  elements.modelStatus.classList.toggle("ready", tone === "ready");
  elements.modelStatus.classList.toggle("error", tone === "error");
}

function setMessage(text, tone = "") {
  elements.message.textContent = text;
  elements.message.classList.toggle("error", tone === "error");
  elements.message.classList.toggle("success", tone === "success");
}

function todayId() {
  return pacificDateId();
}

function formatDateId(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayDate(dateId) {
  const [year, month, day] = (isDateId(dateId) ? dateId : todayId()).split("-");
  return `${month}/${day}/${year}`;
}

function isDateId(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function dateFromId(dateId) {
  const [year, month, day] = dateId.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(dateId, amount) {
  const date = dateFromId(dateId);
  date.setDate(date.getDate() + amount);
  return formatDateId(date);
}

function previousDateId(dateId) {
  return addDays(dateId, -1);
}

function clampDate(dateId) {
  const min = START_DATE;
  const max = todayId();
  if (!isDateId(dateId)) return previousDateId(max);
  if (dateId < min) return min;
  if (dateId > max) return max;
  return dateId;
}

function normalizeTerm(value) {
  return value.normalize("NFKC").trim().toLowerCase();
}

function isWordShape(term) {
  return /^[a-z]{2,15}$/.test(term);
}

function isBlockedWord(term) {
  return blockedWords.has(term);
}

function hashString(input) {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return function nextRandom() {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function getForcedPair() {
  const forcedStart = normalizeTerm(TEST_PARAMS.get("start") || "");
  const forcedTarget = normalizeTerm(TEST_PARAMS.get("target") || "");
  if (USE_MOCK_MODEL && forcedStart && forcedTarget) {
    return {
      start: forcedStart,
      target: forcedTarget,
      gap: Number(TEST_PARAMS.get("gap")) || 1,
      easyPath: [forcedStart, forcedTarget],
      hardPath: [forcedStart, forcedTarget],
    };
  }
  return null;
}

function pickPair(seedText) {
  const random = mulberry32(hashString(seedText));
  for (;;) {
    const start = endpoints[Math.floor(random() * endpoints.length)];
    const target = endpoints[Math.floor(random() * endpoints.length)];
    if (start === target) continue;

    const score = scoreLocalPair(start, target);
    const gap = Math.max(0, 1 - score.similarity);
    if (gap >= MIN_PAIR_GAP && gap <= MAX_PAIR_GAP) {
      return { start, target, gap };
    }
  }
}

function scoreLocalPair(from, to) {
  const fromVector = getLocalVector(from);
  const toVector = getLocalVector(to);
  if (!fromVector || !toVector) return null;
  const similarity = cosineSimilarity(fromVector, toVector);
  return {
    similarity,
    gap: Math.max(0, 1 - similarity),
  };
}

function validatePuzzlePair(pair) {
  if (!pair || typeof pair !== "object") {
    throw new Error("Puzzle data is not valid.");
  }
  for (const word of [pair.start, pair.target]) {
    if (!isWordShape(word)) {
      throw new Error(`Puzzle word "${word}" is not a valid game word.`);
    }
    if (isBlockedWord(word)) {
      throw new Error(`Puzzle word "${word}" is blocked.`);
    }
    if (!USE_MOCK_MODEL && !vectorWords.has(word)) {
      throw new Error(`Puzzle word "${word}" has no loaded vector.`);
    }
  }
  if (!Number.isFinite(pair.gap) || pair.gap <= 0) {
    throw new Error("Puzzle gap is not valid.");
  }
}

function normalizeCachedSolutions(pair, start, target) {
  return Object.fromEntries(
    Object.keys(MODES).map((mode) => [
      mode,
      normalizeCachedSolution(
        pair.solutions?.[mode] || pair[`${mode}Path`],
        start,
        target,
      ),
    ]),
  );
}

function normalizeCachedSolution(value, start, target) {
  const source = Array.isArray(value) ? { path: value } : value;
  if (!source || typeof source !== "object" || !Array.isArray(source.path)) {
    return null;
  }

  const path = source.path.map(normalizeTerm);
  if (
    path.length < 2 ||
    path.length > MAX_STEPS + 1 ||
    path[0] !== start ||
    path[path.length - 1] !== target ||
    new Set(path).size !== path.length
  ) {
    return null;
  }

  for (const word of path) {
    if (
      !isWordShape(word) ||
      !dictionary.has(word) ||
      isBlockedWord(word) ||
      (!USE_MOCK_MODEL && !vectorWords.has(word))
    ) {
      return null;
    }
  }

  return {
    path,
    scores: normalizeCachedScores(source.scores, path),
  };
}

function normalizeCachedScores(scores, path) {
  if (!Array.isArray(scores) || scores.length !== path.length - 1) {
    return [];
  }

  return scores.map((score, index) => ({
    from: typeof score?.from === "string" ? normalizeTerm(score.from) : path[index],
    to: typeof score?.to === "string" ? normalizeTerm(score.to) : path[index + 1],
    similarity: Number.isFinite(score?.similarity) ? roundScore(score.similarity) : 0,
    gap: Number.isFinite(score?.gap) ? roundScore(score.gap) : 0,
    targetGap: Number.isFinite(score?.targetGap) ? roundScore(score.targetGap) : 0,
    at: typeof score?.at === "string" ? score.at : "",
  }));
}

async function buildPuzzle() {
  const kind = storage.kind;
  const date =
    kind === "daily" ? todayId() : kind === "archive" ? storage.archiveDate : "";
  const randomSeed =
    kind === "random" ? storage.randomSeed || createRandomSeed() : "";

  if (kind === "random" && !storage.randomSeed) {
    storage.randomSeed = randomSeed;
    saveStorage();
  }

  const forcedPair = getForcedPair();
  if (!forcedPair && kind === "random") {
    await ensureVectorShardsLoaded("Building random puzzle");
  }
  const pair =
    forcedPair ||
    (kind === "random" ? pickPair(`random:${randomSeed}`) : await fetchDailyPuzzle(date));
  validatePuzzlePair(pair);
  const start = normalizeTerm(pair.start);
  const target = normalizeTerm(pair.target);
  const gap = roundScore(pair.gap || TARGET_PAIR_GAP);
  return {
    kind,
    date: isDateId(pair.date) ? pair.date : date,
    randomSeed,
    start,
    target,
    gap,
    solutions: normalizeCachedSolutions(pair, start, target),
    key: `${kind}:${date || randomSeed}:${start}:${target}:${gap}`,
  };
}

async function fetchDailyPuzzle(date) {
  const response = await fetch(`${PUZZLE_API_URL}?date=${encodeURIComponent(date)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || "Daily puzzle is not available.");
  }
  return payload;
}

function createRandomSeed() {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return `${bytes[0].toString(36)}${bytes[1].toString(36)}`;
}

function gameKey() {
  return `${storage.mode}:${currentPuzzle.key}`;
}

function getMoveLimit(mode = storage.mode) {
  return currentPuzzle.gap / MODES[mode].gapDivisor;
}

function createEmptyRecord() {
  return {
    path: [currentPuzzle.start],
    scores: [],
    done: false,
    status: "playing",
    completedAt: "",
    solution: null,
  };
}

function getRecord() {
  const saved = storage.games[gameKey()];
  if (
    saved &&
    Array.isArray(saved.path) &&
    saved.path[0] === currentPuzzle.start &&
    saved.path.every((term) => typeof term === "string")
  ) {
    return {
      path: saved.path,
      scores: Array.isArray(saved.scores) ? saved.scores : [],
      done: Boolean(saved.done),
      status: saved.status || (saved.done ? "won" : "playing"),
      completedAt: saved.completedAt || "",
      solution:
        saved.solution && typeof saved.solution === "object"
          ? {
              status: saved.solution.status || "hidden",
              path: Array.isArray(saved.solution.path) ? saved.solution.path : [],
              scores: Array.isArray(saved.solution.scores) ? saved.solution.scores : [],
            }
          : null,
    };
  }
  return createEmptyRecord();
}

function persistRecord() {
  storage.games[gameKey()] = currentRecord;
  saveStorage();
}

async function loadGameData() {
  setBootProgress(8, "Loading word list.");
  setStatus("Loading word list");
  setMessage("Loading word list and puzzle index.");
  const fetchBoot = (url, progress, label) =>
    fetch(url).then((response) => {
      setBootProgress(progress, label);
      return response;
    });
  const requests = USE_MOCK_MODEL
    ? [
        fetchBoot(DICTIONARY_URL, 24, "Loaded word list."),
        fetchBoot(BLOCKED_WORDS_URL, 36, "Loaded safety list."),
        fetchBoot(ENDPOINTS_URL, 48, "Loaded puzzle words."),
        fetchBoot(MANIFEST_URL, 60, "Loaded game manifest."),
      ]
    : [
        fetchBoot(DICTIONARY_URL, 18, "Loaded word list."),
        fetchBoot(BLOCKED_WORDS_URL, 28, "Loaded safety list."),
        fetchBoot(ENDPOINTS_URL, 38, "Loaded puzzle words."),
        fetchBoot(LEXICON_URL, 54, "Loaded distance index."),
        fetchBoot(MANIFEST_URL, 62, "Loaded game manifest."),
      ];
  const responses = await Promise.all(requests);

  for (const response of responses) {
    if (!response.ok) {
      throw new Error(`Could not load game data: ${response.status}`);
    }
  }

  const [
    dictionaryResponse,
    blockedWordsResponse,
    endpointsResponse,
    fourthResponse,
    fifthResponse,
  ] = responses;
  setBootProgress(68, "Preparing word list.");
  const dictionaryText = await dictionaryResponse.text();
  dictionary = new Set(dictionaryText.split(/\r?\n/).filter(Boolean));
  blockedWords = new Set((await blockedWordsResponse.json()).words);
  loadEndpointTable(await endpointsResponse.json());
  if (USE_MOCK_MODEL) {
    manifest = await fourthResponse.json();
  } else {
    manifest = await fifthResponse.json();
    loadVectorMetadata(await fourthResponse.json());
  }

  if (dictionary.size < 1000 || (!USE_MOCK_MODEL && endpoints.length < 100) || !manifest) {
    throw new Error("Game data did not contain enough words.");
  }
  setBootProgress(74, "Loading puzzle.");
}

function loadEndpointTable(data) {
  endpoints = data.words;
}

function loadVectorMetadata(data) {
  if (
    !Number.isInteger(data.dim) ||
    !Number.isInteger(data.shardSize) ||
    !Array.isArray(data.words) ||
    !Array.isArray(data.shards)
  ) {
    throw new Error("Vector metadata does not match the word table.");
  }
  vectorDim = data.dim;
  vectorShardSize = data.shardSize;
  vectorWordList = data.words;
  vectorShardPaths = data.shards;
  const expectedShardCount = Math.ceil(vectorWordList.length / vectorShardSize);
  if (data.shards.length !== expectedShardCount) {
    throw new Error("Vector metadata does not match the word table.");
  }
  vectorWords = new Map(data.words.map((word, index) => [word, index]));
  vectorShards = [];
  vectorShardsLoaded = false;
  vectorShardLoadPromise = null;
  vectorCache = new Map();
}

async function ensureVectorShardsLoaded(
  reason = "Loading word distance data",
  progressStart = 35,
  progressEnd = 86,
) {
  if (USE_MOCK_MODEL || vectorShardsLoaded) return;
  if (vectorShardLoadPromise) return vectorShardLoadPromise;
  if (!vectorShardPaths.length) {
    throw new Error("Vector metadata is not loaded.");
  }

  vectorShardLoadPromise = (async () => {
    let completed = 0;
    const total = vectorShardPaths.length;
    setStatus(`${reason}: 0/${total}`);
    setMessage(`${reason}. Loading distance data 0/${total}.`);
    setBootProgress(progressStart, `${reason}: 0/${total}.`);

    vectorShards = await Promise.all(
      vectorShardPaths.map(async (path, shardIndex) => {
        const response = await fetch(`./${path}`);
        if (!response.ok) {
          throw new Error(`Could not load vector shard ${path}: ${response.status}`);
        }
        const shard = new Float32Array(await response.arrayBuffer());
        const expectedRows = Math.min(
          vectorShardSize,
          vectorWordList.length - shardIndex * vectorShardSize,
        );
        const expectedLength = expectedRows * vectorDim;
        if (shard.length !== expectedLength) {
          throw new Error(
            `Vector shard ${path} has ${shard.length} values, expected ${expectedLength}.`,
          );
        }
        completed += 1;
        setStatus(`${reason}: ${completed}/${total}`);
        setMessage(`${reason}. Loading distance data ${completed}/${total}.`);
        setBootProgress(
          progressStart + (completed / total) * (progressEnd - progressStart),
          `${reason}: ${completed}/${total}.`,
        );
        return shard;
      }),
    );
    vectorShardsLoaded = true;
    setStatus("Ready", "ready");
  })();

  try {
    await vectorShardLoadPromise;
  } catch (error) {
    vectorShardLoadPromise = null;
    throw error;
  }
}

function getLocalVector(term) {
  if (USE_MOCK_MODEL) return mockEmbed(term);
  const index = vectorWords.get(term);
  if (index === undefined) return null;
  return getLocalVectorByIndex(index);
}

function getLocalVectorByIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= vectorWordList.length) {
    throw new Error(`Vector index ${String(index)} is not valid.`);
  }
  const shardIndex = Math.floor(index / vectorShardSize);
  const shard = vectorShards[shardIndex];
  if (!shard) {
    throw new Error(`Vector shard ${shardIndex} is not loaded.`);
  }
  const rowStart = (index % vectorShardSize) * vectorDim;
  const rowEnd = rowStart + vectorDim;
  if (rowEnd > shard.length) {
    throw new Error(`Vector row ${index} is outside shard ${shardIndex}.`);
  }
  return shard.subarray(rowStart, rowEnd);
}

async function getVectors(terms) {
  if (USE_MOCK_MODEL) {
    return new Map(terms.map((term) => [normalizeTerm(term), getLocalVector(term)]));
  }

  const normalizedTerms = [...new Set(terms.map(normalizeTerm))];
  const missing = normalizedTerms.filter((term) => !vectorCache.has(term));
  for (const term of missing) {
    if (!dictionary.has(term)) {
      throw new Error("That word is not in the word list.");
    }
    if (!vectorWords.has(term)) {
      throw new Error("That word has no word-distance data.");
    }
  }

  if (missing.length > 0) {
    const response = await fetch(EMBED_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ words: missing }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Could not score those words.");
    }
    const vectors = payload.vectors || {};
    for (const term of missing) {
      const vector = vectors[term];
      if (!Array.isArray(vector) || vector.length !== vectorDim) {
        throw new Error("Word-distance data did not match the game model.");
      }
      vectorCache.set(term, vector);
    }
  }

  return new Map(normalizedTerms.map((term) => [term, vectorCache.get(term)]));
}

function mockEmbed(term) {
  const normalized = normalizeTerm(term);
  if (normalized.includes("reject")) {
    return [1, 0, 0, 0];
  }
  return [0, 1, 0, 0];
}

async function scorePair(from, to) {
  const vectors = await getVectors([from, to]);
  const fromVector = vectors.get(normalizeTerm(from));
  const toVector = vectors.get(normalizeTerm(to));
  const similarity = cosineSimilarity(fromVector, toVector);
  return {
    from,
    to,
    similarity,
    gap: Math.max(0, 1 - similarity),
  };
}

function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function dotSimilarity(left, right) {
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
  }
  return dot;
}

function render() {
  const steps = currentRecord.path.length - 1;
  const moveLimit = getMoveLimit();
  const canPlay = !currentRecord.done;
  const currentWord = currentRecord.path[currentRecord.path.length - 1];
  const kindLabel =
    currentPuzzle.kind === "daily"
      ? displayDate(currentPuzzle.date)
      : currentPuzzle.kind === "archive"
        ? displayDate(currentPuzzle.date)
        : "Random";

  elements.kindButtons.forEach((button) => {
    const isActive = button.dataset.kind === storage.kind;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
  elements.modeButtons.forEach((button) => {
    const isActive = button.dataset.mode === storage.mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  elements.dateControls.hidden = storage.kind !== "archive";
  elements.newRandom.hidden = storage.kind !== "random";
  elements.archiveDate.min = START_DATE;
  elements.archiveDate.max = todayId();
  elements.archiveDate.value = storage.archiveDate;
  elements.previousDay.disabled = storage.archiveDate <= START_DATE;
  elements.nextDay.disabled = storage.archiveDate >= todayId();

  elements.currentWordLabel.textContent = steps === 0 ? "Start" : "Current";
  elements.startWord.textContent = currentWord;
  elements.targetWord.textContent = currentPuzzle.target;
  elements.puzzleLabel.textContent =
    currentPuzzle.kind === "daily" ? `Daily ${kindLabel}` : kindLabel;
  elements.startGapLabel.textContent = `Starting distance: ${currentPuzzle.gap.toFixed(2)}`;
  elements.limitLabel.textContent = `${MODES[storage.mode].label} max move: ${moveLimit.toFixed(
    2,
  )}`;
  elements.stepLabel.textContent = `${steps}/${MAX_STEPS}`;
  elements.puzzleSummary.textContent =
    `Move from ${currentWord} toward ${currentPuzzle.target}. ` +
    `Each move must be distance ${moveLimit.toFixed(2)} or less.`;
  elements.limitMarker.style.left = `${Math.round(
    Math.max(0, Math.min(1, 1 - moveLimit / currentPuzzle.gap)) * 100,
  )}%`;

  elements.guessInput.disabled = !canPlay;
  elements.submitGuess.disabled = !canPlay;
  elements.undoStep.disabled = !canPlay || currentRecord.path.length <= 1;
  elements.resetGame.disabled = currentRecord.path.length <= 1 && !currentRecord.done;
  elements.giveUp.disabled = !canPlay;
  elements.shareResult.disabled = !currentRecord.done;

  const shareText = currentRecord.done ? buildShareText() : "";
  elements.shareRow.hidden = true;
  elements.shareText.value = shareText;
  elements.shareResult.textContent = "Copy result";

  elements.pathList.replaceChildren(
    ...currentRecord.path.map((term, index) =>
      createGuessRow(term, index, currentRecord.scores[index - 1]),
    ),
  );
  renderPathChips();

  renderResult();
  renderSolution();
  renderStats();
}

function renderPathChips() {
  elements.pathChips.replaceChildren(
    ...currentRecord.path.map((term, index) => {
      const item = document.createElement("li");
      item.className = index === currentRecord.path.length - 1 ? "current" : "";
      item.textContent = term;
      return item;
    }),
  );
}

function renderResult() {
  elements.resultPanel.hidden = !currentRecord.done;
  if (!currentRecord.done) {
    elements.resultText.className = "";
    elements.resultText.textContent = "";
    return;
  }

  elements.resultTitle.textContent =
    currentRecord.status === "won"
      ? "Solved"
      : currentRecord.status === "gave-up"
        ? "Gave up"
        : "Game over";
  elements.resultText.className = "share-preview";
  elements.resultText.textContent = buildShareText();
}

function renderSolution() {
  const solution = currentRecord.solution;
  elements.solutionSection.hidden = !solution;
  if (!solution) {
    elements.solutionStatus.textContent = "Waiting";
    elements.solutionPathList.replaceChildren();
    elements.resultSolution.textContent = "";
    return;
  }

  if (solution.status === "searching") {
    elements.solutionStatus.textContent = "Searching";
    elements.resultSolution.textContent = "RelateBot is looking for a path.";
  } else if (solution.status === "ready") {
    elements.solutionStatus.textContent = `${Math.max(0, solution.path.length - 1)}/${MAX_STEPS}`;
    elements.resultSolution.textContent = `RelateBot's solution: ${solution.path.join(" -> ")}`;
  } else {
    elements.solutionStatus.textContent = "No path found";
    elements.resultSolution.textContent = "RelateBot did not find a valid path.";
  }

  elements.solutionPathList.replaceChildren(
    ...solution.path.map((term, index) => createGuessRow(term, index, solution.scores[index - 1])),
  );
}

function createGuessRow(term, index, score) {
  const row = document.createElement("tr");
  row.className = "path-row";

  const number = document.createElement("td");
  number.dataset.label = "Move";
  number.textContent = index === 0 ? "0" : String(index);

  const word = document.createElement("td");
  word.dataset.label = "Word";
  word.className = "path-word";
  word.textContent = term;

  const stepGap = document.createElement("td");
  stepGap.dataset.label = "From prev.";
  stepGap.textContent = score ? score.gap.toFixed(2) : "-";

  const targetGap = document.createElement("td");
  targetGap.dataset.label = "To target";
  targetGap.textContent = score ? score.targetGap.toFixed(2) : currentPuzzle.gap.toFixed(2);

  const read = document.createElement("td");
  read.dataset.label = "Status";
  const badge = document.createElement("span");
  const readout = score ? proximityRead(score.targetGap) : { className: "start", label: "start" };
  badge.className = `read-badge ${readout.className}`;
  badge.textContent = readout.label;
  read.append(badge);

  row.append(number, word, stepGap, targetGap, read);
  return row;
}

function proximityRead(targetGap) {
  if (targetGap <= 0.000001) return { className: "target", label: "at target" };
  const ratio = targetGap / currentPuzzle.gap;
  if (ratio <= 0.25) return { className: "hot", label: "very close" };
  if (ratio <= 0.5) return { className: "warm", label: "close" };
  if (ratio <= 0.75) return { className: "closer", label: "closer" };
  return { className: "cold", label: "far" };
}

function renderStats() {
  const stats = storage.stats[storage.mode] || defaultStorage.stats[storage.mode];
  elements.playedStat.textContent = stats.played;
  elements.winsStat.textContent = stats.wins;
  elements.bestStat.textContent = stats.best ?? "-";
  elements.avgStat.textContent =
    stats.wins > 0 ? (stats.totalSteps / stats.wins).toFixed(1) : "-";
}

async function updateTargetGap() {
  const requestId = ++targetGapRequest;
  const current = currentRecord.path[currentRecord.path.length - 1];
  if (current === currentPuzzle.start) {
    renderTargetGap(currentPuzzle.gap);
    return;
  }
  elements.targetGap.textContent = "Scoring";
  elements.targetGapBar.style.width = "0%";
  elements.targetGapBar.className = "";

  try {
    const score = await scorePair(current, currentPuzzle.target);
    if (requestId !== targetGapRequest) return;
    renderTargetGap(score.gap);
  } catch (error) {
    if (requestId !== targetGapRequest) return;
    elements.targetGap.textContent = "Unavailable";
    elements.targetGapBar.className = "blocked";
    setMessage(error.message || "Could not score that word.", "error");
  }
}

function renderTargetGap(gap) {
  const progress = Math.max(0, Math.min(1, 1 - gap / currentPuzzle.gap));
  elements.targetGap.textContent = `${gap.toFixed(2)} away`;
  elements.targetGapBar.style.width = `${Math.round(progress * 100)}%`;
  elements.targetGapBar.className =
    gap <= getMoveLimit() ? "reachable" : progress > 0.5 ? "warning" : "blocked";
}

async function handleGuessSubmit(event) {
  event.preventDefault();
  if (!currentPuzzle || currentRecord.done) return;

  const term = normalizeTerm(elements.guessInput.value);
  const previous = currentRecord.path[currentRecord.path.length - 1];
  const moveLimit = getMoveLimit();

  if (!isWordShape(term)) {
    setMessage("Use one word, 2 to 15 letters.", "error");
    trackEvent("guess", { outcome: "rejected", reason: "invalid_shape" });
    focusGuessInput();
    return;
  }
  if (!dictionary.has(term)) {
    setMessage("That word is not in the word list.", "error");
    trackEvent("guess", { outcome: "rejected", reason: "missing_dictionary" });
    focusGuessInput();
    return;
  }
  if (term === previous) {
    setMessage(`${term} is already your current word. Try a different step.`, "error");
    trackEvent("guess", { outcome: "rejected", reason: "repeat_current" });
    focusGuessInput();
    return;
  }
  if (currentRecord.path.includes(term)) {
    setMessage(`${term} is already in your path. Use each word once.`, "error");
    trackEvent("guess", { outcome: "rejected", reason: "duplicate_path" });
    focusGuessInput();
    return;
  }

  setBusy(true);
  setMessage(`Checking ${previous} to ${term}.`);

  try {
    const [stepScore, targetScore] = await Promise.all([
      scorePair(previous, term),
      scorePair(term, currentPuzzle.target),
    ]);

    if (stepScore.gap > moveLimit + 0.000001) {
      setMessage(
        `Too far from ${previous}: distance ${stepScore.gap.toFixed(
          2,
        )}, max ${moveLimit.toFixed(2)}. No move used.`,
        "error",
      );
      trackEvent("guess", {
        outcome: "rejected",
        reason: "too_far",
        stepGap: stepScore.gap,
        targetGap: targetScore.gap,
      });
      return;
    }

    currentRecord.path.push(term);
    currentRecord.scores.push({
      from: previous,
      to: term,
      similarity: roundScore(stepScore.similarity),
      gap: roundScore(stepScore.gap),
      targetGap: roundScore(targetScore.gap),
      at: new Date().toISOString(),
    });
    elements.guessInput.value = "";
    trackEvent("guess", {
      outcome: "accepted",
      stepGap: stepScore.gap,
      targetGap: targetScore.gap,
    });

    if (term === currentPuzzle.target) {
      finishGame("won", "Solved.");
    } else if (currentRecord.path.length - 1 >= MAX_STEPS) {
      finishGame("lost", "Out of steps.");
    } else {
      const readout = proximityRead(targetScore.gap);
      setMessage(
        `Accepted. ${term} is ${targetScore.gap.toFixed(2)} from target (${readout.label}).`,
        "success",
      );
    }

    persistRecord();
    render();
    updateTargetGap();
    if (currentRecord.done) {
      showResult();
      revealRelateBotSolution();
    }
  } catch (error) {
    setMessage(error.message || "Could not score that step.", "error");
    trackEvent("guess", { outcome: "rejected", reason: "score_error" });
  } finally {
    setBusy(false);
    focusGuessInput();
  }
}

function setBusy(isBusy) {
  elements.submitGuess.textContent = isBusy ? "Checking" : "Try word";
  if (currentRecord.done) return;
  elements.guessInput.disabled = isBusy;
  elements.submitGuess.disabled = isBusy;
}

function focusGuessInput() {
  if (!currentRecord || currentRecord.done || elements.guessInput.disabled) return;
  requestAnimationFrame(() => {
    if (!currentRecord.done && !elements.guessInput.disabled) {
      elements.guessInput.focus({ preventScroll: true });
    }
  });
}

async function revealRelateBotSolution() {
  if (currentRecord.solution?.status === "ready" || currentRecord.solution?.status === "none") {
    return;
  }

  currentRecord.solution = { status: "searching", path: [], scores: [] };
  persistRecord();
  render();

  try {
    const cachedSolution = getCachedRelateBotSolution(storage.mode);
    if (cachedSolution) {
      currentRecord.solution = {
        status: "ready",
        path: cachedSolution.path,
        scores: cachedSolution.scores,
      };
    } else if (currentPuzzle.kind !== "random") {
      currentRecord.solution = { status: "none", path: [], scores: [] };
    } else {
      const path = await findRelateBotPath(getMoveLimit(), "Finding RelateBot path", 35, 86);
      if (path) {
        currentRecord.solution = {
          status: "ready",
          path,
          scores: await scoreSolutionPath(path),
        };
      } else {
        currentRecord.solution = { status: "none", path: [], scores: [] };
      }
    }
  } catch (error) {
    setMessage(error.message || "RelateBot could not score this puzzle.", "error");
    currentRecord.solution = { status: "none", path: [], scores: [] };
  }

  persistRecord();
  render();
}

async function findRelateBotPath(
  moveLimit = getMoveLimit(),
  reason = "Finding RelateBot path",
  progressStart = 35,
  progressEnd = 86,
) {
  const direct = await scorePair(currentPuzzle.start, currentPuzzle.target);
  if (direct.gap <= moveLimit + 0.000001) {
    return [currentPuzzle.start, currentPuzzle.target];
  }

  await ensureVectorShardsLoaded(reason, progressStart, progressEnd);
  const shortPath = await findShortBridgePath(moveLimit);
  if (shortPath) return shortPath;

  return findGreedyRelateBotPath(moveLimit);
}

async function findShortBridgePath(moveLimit) {
  if (USE_MOCK_MODEL) return null;

  const minSimilarity = 1 - moveLimit - 0.000001;
  const startIndex = vectorWords.get(currentPuzzle.start);
  const targetIndex = vectorWords.get(currentPuzzle.target);
  const startNeighbors = await scanNeighborIndices(startIndex, minSimilarity);
  const targetNeighbors = await scanNeighborIndices(targetIndex, minSimilarity);
  const targetNeighborSet = new Set(targetNeighbors);

  for (const middle of startNeighbors) {
    if (targetNeighborSet.has(middle)) {
      return [
        currentPuzzle.start,
        vectorWordList[middle],
        currentPuzzle.target,
      ];
    }
  }

  for (const left of startNeighbors) {
    const leftVector = getLocalVectorByIndex(left);
    for (const right of targetNeighbors) {
      if (dotSimilarity(leftVector, getLocalVectorByIndex(right)) >= minSimilarity) {
        return [
          currentPuzzle.start,
          vectorWordList[left],
          vectorWordList[right],
          currentPuzzle.target,
        ];
      }
    }
  }

  return null;
}

async function scanNeighborIndices(baseIndex, minSimilarity) {
  const baseVector = getLocalVectorByIndex(baseIndex);
  const neighbors = [];
  for (let index = 0; index < vectorWordList.length; index += 1) {
    const word = vectorWordList[index];
    if (
      index !== baseIndex &&
      !isBlockedWord(word) &&
      dotSimilarity(baseVector, getLocalVectorByIndex(index)) >= minSimilarity
    ) {
      neighbors.push(index);
    }
  }
  return neighbors;
}

async function findGreedyRelateBotPath(moveLimit) {
  const path = [currentPuzzle.start];
  const used = new Set(path);

  const targetVector = getLocalVector(currentPuzzle.target);
  if (!targetVector) return null;

  while (path.length - 1 < MAX_STEPS) {
    const from = path[path.length - 1];
    const directTarget = await scorePair(from, currentPuzzle.target);
    if (directTarget.gap <= moveLimit + 0.000001) {
      path.push(currentPuzzle.target);
      return path;
    }

    const fromVector = getLocalVector(from);
    const currentTargetGap = directTarget.gap;
    let best = null;

    for (let index = 0; index < vectorWordList.length; index += 1) {
      const word = vectorWordList[index];
      if (used.has(word) || word === currentPuzzle.target || isBlockedWord(word)) continue;

      const vector = getLocalVectorByIndex(index);
      const stepGap = Math.max(0, 1 - dotSimilarity(fromVector, vector));
      if (stepGap > moveLimit + 0.000001 || stepGap < 0.01) continue;

      const targetGap = Math.max(0, 1 - dotSimilarity(vector, targetVector));
      if (targetGap < currentTargetGap - 0.01 && (!best || targetGap < best.targetGap)) {
        best = { word, targetGap };
      }
    }

    if (!best) return null;
    path.push(best.word);
    used.add(best.word);
  }

  return null;
}

async function scoreSolutionPath(path) {
  const scores = [];
  for (let index = 1; index < path.length; index += 1) {
    const stepScore = await scorePair(path[index - 1], path[index]);
    const targetScore = await scorePair(path[index], currentPuzzle.target);
    scores.push({
      from: path[index - 1],
      to: path[index],
      similarity: roundScore(stepScore.similarity),
      gap: roundScore(stepScore.gap),
      targetGap: roundScore(targetScore.gap),
      at: new Date().toISOString(),
    });
  }
  return scores;
}

function roundScore(value) {
  return Math.round(value * 10000) / 10000;
}

function finishGame(status, message) {
  if (currentRecord.done) return;
  const steps = currentRecord.path.length - 1;
  currentRecord.done = true;
  currentRecord.status = status;
  currentRecord.completedAt = new Date().toISOString();

  const stats = storage.stats[storage.mode];
  stats.played += 1;
  if (status === "won") {
    stats.wins += 1;
    stats.totalSteps += steps;
    stats.best = stats.best === null ? steps : Math.min(stats.best, steps);
  }
  setMessage(message, status === "won" ? "success" : "error");
  trackEvent("game_end", { result: status, stepCount: steps });
}

function showResult() {
  requestAnimationFrame(() => {
    elements.resultPanel.scrollIntoView({ block: "nearest" });
  });
}

async function giveUp() {
  if (currentRecord.done) return;
  finishGame("gave-up", "Gave up.");
  persistRecord();
  render();
  showResult();
  await revealRelateBotSolution();
}

function resetCurrentGame() {
  trackEvent("reset", { stepCount: Math.max(0, currentRecord.path.length - 1) });
  currentRecord = createEmptyRecord();
  persistRecord();
  setMessage("Puzzle reset.");
  render();
  updateTargetGap();
  elements.guessInput.focus();
}

function undoStep() {
  if (currentRecord.done || currentRecord.path.length <= 1) return;
  trackEvent("undo", { stepCount: Math.max(0, currentRecord.path.length - 1) });
  currentRecord.path.pop();
  currentRecord.scores.pop();
  persistRecord();
  setMessage("Last step removed.");
  render();
  updateTargetGap();
  elements.guessInput.focus();
}

function hasActiveProgress() {
  return currentRecord && !currentRecord.done && currentRecord.path.length > 1;
}

function getCachedRelateBotSolution(mode = storage.mode) {
  return currentPuzzle?.solutions?.[mode] || null;
}

function needsLiveHardCheck() {
  return currentPuzzle?.kind === "random" && !getCachedRelateBotSolution("hard");
}

function hardUnavailableMessage() {
  return currentPuzzle?.kind === "random"
    ? "Hard is unavailable for this puzzle. RelateBot could not find a hard path."
    : "Hard is unavailable for this puzzle. There is no cached hard path.";
}

async function getHardRelateBotPath() {
  if (!currentPuzzle) return null;
  const cachedSolution = getCachedRelateBotSolution("hard");
  if (cachedSolution) return cachedSolution.path;
  if (currentPuzzle.kind !== "random") return null;

  const cacheKey = currentPuzzle.key;
  if (hardPathCache.has(cacheKey)) {
    return hardPathCache.get(cacheKey);
  }
  const path = await findRelateBotPath(
    getMoveLimit("hard"),
    "Checking hard path",
    68,
    92,
  );
  hardPathCache.set(cacheKey, path);
  return path;
}

async function canUseHardMode() {
  const path = await getHardRelateBotPath();
  return Boolean(path);
}

function switchKind(kind) {
  if (!["daily", "random", "archive"].includes(kind)) return;
  if (kind !== storage.kind && hasActiveProgress()) {
    setMessage("Finish, reset, or undo to the start before changing puzzles.", "error");
    focusGuessInput();
    return;
  }
  storage.kind = kind;
  if (kind === "archive") {
    storage.archiveDate = clampDate(storage.archiveDate);
  }
  if (kind === "random" && !storage.randomSeed) {
    storage.randomSeed = createRandomSeed();
  }
  saveStorage();
  queuePuzzleLoad();
}

async function switchMode(mode) {
  if (!MODES[mode]) return;
  if (mode !== storage.mode && hasActiveProgress()) {
    setMessage("Finish, reset, or undo to the start before changing difficulty.", "error");
    focusGuessInput();
    return;
  }
  if (mode === "hard" && mode !== storage.mode) {
    const shouldCheckLive = needsLiveHardCheck();
    if (shouldCheckLive) {
      setBootProgress(64, "Checking hard path.");
      setStatus("Checking hard path");
      setMessage("Checking whether Hard has a RelateBot path.");
    }
    try {
      if (!(await canUseHardMode())) {
        if (shouldCheckLive) hideBoot();
        setStatus("Ready", "ready");
        setMessage(hardUnavailableMessage(), "error");
        focusGuessInput();
        return;
      }
    } catch (error) {
      if (shouldCheckLive) hideBoot();
      setStatus("Ready", "ready");
      setMessage(error.message || "Could not check Hard for this puzzle.", "error");
      focusGuessInput();
      return;
    }
  }
  storage.mode = mode;
  saveStorage();
  queuePuzzleLoad();
}

async function loadPuzzle() {
  setBootProgress(78, "Loading puzzle.");
  currentPuzzle = await buildPuzzle();
  let hardUnavailable = false;
  if (storage.mode === "hard") {
    if (needsLiveHardCheck()) {
      setBootProgress(82, "Checking hard path.");
    }
    if (!(await canUseHardMode())) {
      storage.mode = "easy";
      saveStorage();
      hardUnavailable = true;
      setBootProgress(90, "Hard unavailable. Loading Easy.");
    }
  }
  currentRecord = getRecord();
  render();
  if (currentRecord.done) {
    setMessage(
      currentRecord.status === "won" ? "Solved." : "Game over.",
      currentRecord.status === "won" ? "success" : "error",
    );
  } else if (hardUnavailable) {
    setMessage(hardUnavailableMessage(), "error");
  } else {
    setMessage("Type a word close to your current word. Rejected words do not use a move.");
  }
  updateTargetGap();
  if (currentRecord.done && !currentRecord.solution) {
    revealRelateBotSolution();
  }
  focusGuessInput();
  trackPuzzleView();
}

function queuePuzzleLoad() {
  setBootProgress(76, "Loading puzzle.");
  setStatus("Loading puzzle");
  setMessage("Loading puzzle.");
  loadPuzzle()
    .then(() => {
      setStatus("Ready", "ready");
      hideBoot();
    })
    .catch((error) => {
      setStatus("Error", "error");
      setMessage(error.message || "Could not load that puzzle.", "error");
      showBootError(error.message || "Could not load that puzzle.");
    });
}

function setArchiveDate(dateId) {
  if ((storage.kind !== "archive" || dateId !== storage.archiveDate) && hasActiveProgress()) {
    setMessage("Finish, reset, or undo to the start before changing puzzles.", "error");
    focusGuessInput();
    return;
  }
  storage.kind = "archive";
  storage.archiveDate = clampDate(dateId);
  saveStorage();
  queuePuzzleLoad();
}

function newRandomPuzzle() {
  if (hasActiveProgress()) {
    setMessage("Finish, reset, or undo to the start before changing puzzles.", "error");
    focusGuessInput();
    return;
  }
  storage.kind = "random";
  storage.randomSeed = createRandomSeed();
  saveStorage();
  queuePuzzleLoad();
}

async function shareCurrentResult() {
  if (!currentRecord.done) return;
  const text = buildShareText();
  trackEvent("share", {
    result: currentRecord.status,
    stepCount: Math.max(0, currentRecord.path.length - 1),
  });
  try {
    await navigator.clipboard.writeText(text);
    elements.shareResult.textContent = "Copied";
    setMessage("Result copied.", "success");
  } catch {
    elements.shareRow.hidden = false;
    elements.shareText.focus();
    elements.shareText.select();
    setMessage("Share text selected.");
  }
}

function buildShareText() {
  const steps = Math.min(MAX_STEPS, currentRecord.path.length - 1);
  const score = currentRecord.status === "won" ? String(steps) : "X";
  const date = currentPuzzle.date || todayId();
  return `The Relating Game ${displayDate(date)} | ${MODES[storage.mode].label} ${score}/${MAX_STEPS} | ${SHARE_SITE}`;
}

function wireEvents() {
  elements.kindButtons.forEach((button) => {
    button.addEventListener("click", () => switchKind(button.dataset.kind));
  });
  elements.modeButtons.forEach((button) => {
    button.addEventListener("click", () => switchMode(button.dataset.mode));
  });
  elements.archiveDate.addEventListener("change", () => {
    setArchiveDate(elements.archiveDate.value);
  });
  elements.previousDay.addEventListener("click", () => {
    setArchiveDate(addDays(storage.archiveDate, -1));
  });
  elements.nextDay.addEventListener("click", () => {
    setArchiveDate(addDays(storage.archiveDate, 1));
  });
  elements.newRandom.addEventListener("click", newRandomPuzzle);
  elements.guessForm.addEventListener("submit", handleGuessSubmit);
  elements.undoStep.addEventListener("click", undoStep);
  elements.resetGame.addEventListener("click", resetCurrentGame);
  elements.giveUp.addEventListener("click", giveUp);
  elements.shareResult.addEventListener("click", shareCurrentResult);
  elements.copyShare.addEventListener("click", shareCurrentResult);
}

async function init() {
  wireEvents();
  setBootProgress(5, "Loading page.");
  elements.archiveDate.min = START_DATE;
  elements.archiveDate.max = todayId();
  storage.archiveDate = clampDate(storage.archiveDate);
  applyStartupRoute();

  try {
    await loadGameData();
    await loadPuzzle();
    setStatus("Ready", "ready");
    setBootProgress(100, "Ready.");
    hideBoot();
    trackEvent("app_ready", { loadMs: Math.round(performance.now() - appStartedAt) });
  } catch (error) {
    setStatus("Error", "error");
    setMessage(error.message || "Could not prepare the puzzle.", "error");
    showBootError(error.message || "Could not prepare the puzzle.");
  }
}

init();
