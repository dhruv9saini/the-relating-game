import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { isPacificMidnight, pacificDateId } from "../public/shared/pacific-time.js";
import { DAILY_PUZZLES } from "../src/shared/daily-schedule.js";

function cosineSimilarity(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

test("uses the Pacific calendar day for daily rollover", () => {
  expect(pacificDateId("2026-06-10T06:59:00Z")).toBe("2026-06-09");
  expect(pacificDateId("2026-06-10T07:00:00Z")).toBe("2026-06-10");
  expect(pacificDateId("2026-12-10T07:59:00Z")).toBe("2026-12-09");
  expect(pacificDateId("2026-12-10T08:00:00Z")).toBe("2026-12-10");
});

test("daily worker cron covers Pacific midnight in daylight and standard time", async () => {
  const config = await readFile("workers/daily/wrangler.toml", "utf8");

  expect(config).toContain('crons = ["0 7 * * *", "0 8 * * *"]');
  expect(isPacificMidnight("2026-06-10T07:00:00Z")).toBe(true);
  expect(isPacificMidnight("2026-06-10T08:00:00Z")).toBe(false);
  expect(isPacificMidnight("2026-12-10T07:00:00Z")).toBe(false);
  expect(isPacificMidnight("2026-12-10T08:00:00Z")).toBe(true);
});

test("scheduled daily puzzles all have cached bot paths without blocked words", async () => {
  const blockedWords = new Set(
    JSON.parse(await readFile("public/data/blocked-words.json", "utf8")).words,
  );

  for (const [date, start, target, gap, easyPath, hardPath] of DAILY_PUZZLES) {
    expect(gap, `${date} gap`).toBeGreaterThan(0);
    expect(Array.isArray(easyPath), `${date} easy path`).toBeTruthy();
    expect(Array.isArray(hardPath), `${date} hard path`).toBeTruthy();
    expect(blockedWords.has(start), `${date} blocked start word ${start}`).toBeFalsy();
    expect(blockedWords.has(target), `${date} blocked target word ${target}`).toBeFalsy();
    expect(easyPath[0], `${date} easy path start`).toBe(start);
    expect(easyPath.at(-1), `${date} easy path target`).toBe(target);
    expect(easyPath.length, `${date} easy path length`).toBeLessThanOrEqual(11);
    expect(hardPath[0], `${date} hard path start`).toBe(start);
    expect(hardPath.at(-1), `${date} hard path target`).toBe(target);
    expect(hardPath.length, `${date} hard path length`).toBeLessThanOrEqual(11);

    for (const [label, path] of [
      ["easy", easyPath],
      ["hard", hardPath],
    ]) {
      for (const word of path) {
        expect(blockedWords.has(word), `${date} ${label} path blocked word ${word}`).toBeFalsy();
      }
    }
  }
});

async function routeTinyGameData(page, overrides = {}) {
  const dictionaryWords =
    overrides.dictionaryWords ||
    ["alpha", "beta", ...Array.from({ length: 1000 }, (_, index) => `dummyword${index}`)];
  const endpointWords =
    overrides.endpointWords ||
    Array.from({ length: 101 }, (_, index) => `endpointword${index}`);
  const lexicon =
    overrides.lexicon || {
      dim: 2,
      shardSize: 1,
      words: ["alpha"],
      shards: ["data/vectors/000.bin"],
    };
  const shard =
    overrides.shard ||
    Buffer.from(new Float32Array([1, 0]).buffer);

  await page.route("**/data/dictionary.txt", async (route) => {
    if (overrides.dictionaryGate) await overrides.dictionaryGate;
    await route.fulfill({ contentType: "text/plain", body: `${dictionaryWords.join("\n")}\n` });
  });
  await page.route("**/data/blocked-words.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify({ words: [] }) }),
  );
  await page.route("**/data/endpoints.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ words: endpointWords }),
    }),
  );
  await page.route("**/data/manifest.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        dictionaryWords: dictionaryWords.length,
        endpointWords: endpointWords.length,
        vectorWords: lexicon.words.length,
        vectorDim: lexicon.dim,
      }),
    }),
  );
  await page.route("**/data/lexicon.json", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(lexicon) }),
  );
  await page.route("**/data/vectors/000.bin", (route) => {
    overrides.onShardRequest?.();
    return route.fulfill({ contentType: "application/octet-stream", body: shard });
  });
}

async function routeEmbedVectors(page, vectors) {
  await page.route("**/api/embed", async (route) => {
    const body = route.request().postDataJSON();
    const words = Array.isArray(body.words) ? body.words : [body.word];
    const normalizedWords = words.map((word) => String(word).trim().toLowerCase());
    const payloadVectors = Object.fromEntries(
      normalizedWords.map((word) => [word, vectors[word]]),
    );

    if (Array.isArray(body.words)) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ vectors: payloadVectors }),
      });
      return;
    }

    const word = normalizedWords[0];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ word, vector: vectors[word] }),
    });
  });
}

test("shows boot progress before the game is ready", async ({ page }) => {
  let releaseDictionary;
  const dictionaryGate = new Promise((resolve) => {
    releaseDictionary = resolve;
  });
  await routeTinyGameData(page, {
    dictionaryGate,
    dictionaryWords: [
      "cat",
      "dog",
      ...Array.from({ length: 1000 }, (_, index) => `dummyword${index}`),
    ],
  });

  const gotoPromise = page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  await expect(page.locator("#bootScreen")).toBeVisible();
  await expect(page.locator("#bootProgress")).toBeVisible();
  await expect(page.locator("#bootText")).not.toContainText("Ready");

  releaseDictionary();
  await gotoPromise;
  await expect(page.locator("#bootScreen")).toBeHidden();
  await expect(page.locator("#guessInput")).toBeEnabled();
});

test("plain root starts on Daily even when Random was saved", async ({ page }) => {
  let shardRequests = 0;
  await page.addInitScript(() => {
    localStorage.setItem(
      "the-relating-game:v3",
      JSON.stringify({ kind: "random", randomSeed: "stale-random", mode: "easy" }),
    );
  });
  await routeTinyGameData(page, {
    dictionaryWords: [
      "alpha",
      "beta",
      ...Array.from({ length: 1000 }, (_, index) => `dummyword${index}`),
    ],
    lexicon: {
      dim: 2,
      shardSize: 2,
      words: ["alpha", "beta"],
      shards: ["data/vectors/000.bin"],
    },
    shard: Buffer.from(new Float32Array([1, 0, 0, 1]).buffer),
    onShardRequest: () => {
      shardRequests += 1;
    },
  });
  await page.route("**/api/puzzle?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        date: "2026-06-10",
        start: "alpha",
        target: "beta",
        gap: 1,
        easyPath: ["alpha", "beta"],
        hardPath: ["alpha", "beta"],
      }),
    }),
  );

  await page.goto("/");

  await expect(page.locator("#guessInput")).toBeEnabled();
  await expect(page.locator("#startWord")).toHaveText("alpha");
  await expect(page.locator("#targetWord")).toHaveText("beta");
  await expect(page.getByRole("button", { name: "Daily" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#newRandom")).toBeHidden();
  const savedKind = await page.evaluate(
    () => JSON.parse(localStorage.getItem("the-relating-game:v3")).kind,
  );
  expect(savedKind).toBe("daily");
  expect(shardRequests).toBe(0);
});

test("plays a mocked puzzle through to completion", async ({ page }) => {
  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  await expect(page.getByRole("heading", { name: "The Relating Game" })).toBeVisible();
  await expect(page.locator("#startWord")).toHaveText("cat");
  await expect(page.locator("#targetWord")).toHaveText("dog");
  await expect(page.locator("#modelStatus")).toHaveText("Ready");

  await page.getByRole("button", { name: "Hard" }).click();
  await expect(page.locator("#limitLabel")).toContainText("Hard max move: 0.50");
  await expect(page.locator("#guessInput")).toBeFocused();

  await page.locator("#guessInput").fill("bridge");
  await page.getByRole("button", { name: "Try word" }).click();
  await expect(page.locator("#message")).toContainText("Accepted");
  await expect(page.locator("#currentWordLabel")).toHaveText("Current");
  await expect(page.locator("#startWord")).toHaveText("bridge");
  await expect(page.locator("#pathChips li")).toHaveCount(2);
  await expect(page.locator("#guessInput")).toBeFocused();

  await page.locator("#guessInput").fill("dog");
  await page.keyboard.press("Enter");

  await expect(page.locator("#resultPanel")).toBeVisible();
  await expect(page.locator("#resultText")).toContainText("Hard 2/10");
  await expect(page.locator("#resultSolution")).toContainText("RelateBot's solution: cat -> dog");
  await expect(page.locator("#solutionSection")).toBeVisible();
  await expect(page.locator("#solutionStatus")).toContainText("/10");
  await expect(page.locator("#shareResult")).toBeEnabled();
  await expect(page.locator("#shareText")).toHaveValue(
    /The Relating Game \d{2}\/\d{2}\/\d{4} \| Hard 2\/10 \| relating-game\.pages\.dev/,
  );
});

test("sends aggregate gameplay analytics without submitted words", async ({ page }) => {
  const events = [];
  await page.route("**/api/analytics", async (route) => {
    events.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 204 });
  });

  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");
  await page.locator("#guessInput").fill("bridge");
  await page.getByRole("button", { name: "Try word" }).click();

  await expect.poll(() => events.some((event) => event.type === "puzzle_view")).toBe(true);
  await expect
    .poll(() =>
      events.some((event) => event.type === "guess" && event.outcome === "accepted"),
    )
    .toBe(true);
  expect(JSON.stringify(events)).not.toContain("bridge");
  expect(events.every((event) => event.sessionId && event.mode && event.kind)).toBe(true);
});

test("rejects a semantic distance over the selected limit", async ({ page }) => {
  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  await page.locator("#guessInput").fill("rejecting");
  await page.getByRole("button", { name: "Try word" }).click();

  await expect(page.locator("#message")).toContainText("Too far from cat");
  await expect(page.locator(".path-row")).toHaveCount(1);
});

test("rejects guesses outside the dictionary", async ({ page }) => {
  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  await page.locator("#guessInput").fill("notawordzz");
  await page.getByRole("button", { name: "Try word" }).click();

  await expect(page.locator("#message")).toContainText("not in the word list");
  await expect(page.locator(".path-row")).toHaveCount(1);
});

test("allows submitted blocked words", async ({ page }) => {
  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  await page.locator("#guessInput").fill("sexuality");
  await page.getByRole("button", { name: "Try word" }).click();

  await expect(page.locator("#message")).toContainText("Accepted");
  await expect(page.locator("#startWord")).toHaveText("sexuality");
  await expect(page.locator(".path-row")).toHaveCount(2);
});

test("ends after ten accepted non-target steps", async ({ page }) => {
  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  for (const word of [
    "bridge",
    "water",
    "fire",
    "earth",
    "metal",
    "stone",
    "music",
    "paper",
    "chair",
    "glass",
  ]) {
    await page.locator("#guessInput").fill(word);
    await page.getByRole("button", { name: "Try word" }).click();
  }

  await expect(page.locator("#message")).toContainText("Out of steps");
  await expect(page.locator("#guessInput")).toBeDisabled();
  await expect(page.locator("#shareText")).toHaveValue(/Easy X\/10/);
  await expect(page.locator("#solutionSection")).toBeVisible();
  await expect(page.locator("#solutionStatus")).toContainText("/10");
});

test("give up ends the game and reveals RelateBot's solution", async ({ page }) => {
  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  await expect(page.getByRole("button", { name: "Bot fight" })).toHaveCount(0);
  await page.getByRole("button", { name: "Give up" }).click();

  await expect(page.locator("#resultPanel")).toBeVisible();
  await expect(page.locator("#resultTitle")).toHaveText("Gave up");
  await expect(page.locator("#resultText")).toContainText("Easy X/10");
  await expect(page.locator("#resultSolution")).toContainText("RelateBot's solution: cat -> dog");
  await expect(page.locator("#solutionSection")).toBeVisible();
  await expect(page.locator("#solutionPathList .path-word")).toContainText(["cat", "dog"]);
  await expect(page.locator("#guessInput")).toBeDisabled();
});

test("keeps an in-progress path when difficulty changes are attempted", async ({ page }) => {
  await page.goto("/?mockModel=1&start=cat&target=dog&gap=1");

  await page.locator("#guessInput").fill("bridge");
  await page.getByRole("button", { name: "Try word" }).click();
  await page.getByRole("button", { name: "Hard" }).click();

  await expect(page.locator("#message")).toContainText("before changing difficulty");
  await expect(page.locator("#limitLabel")).toContainText("Easy max move: 0.67");
  await expect(page.locator("#pathList .path-word")).toContainText(["cat", "bridge"]);
});

test("does not switch to Hard when RelateBot has no hard path", async ({ page }) => {
  let shardRequests = 0;
  const dictionaryWords = [
    "alpha",
    "beta",
    ...Array.from({ length: 1000 }, (_, index) => `dummyword${index}`),
  ];
  await routeTinyGameData(page, {
    dictionaryWords,
    lexicon: {
      dim: 2,
      shardSize: 2,
      words: ["alpha", "beta"],
      shards: ["data/vectors/000.bin"],
    },
    shard: Buffer.from(new Float32Array([1, 0, 0, 1]).buffer),
    onShardRequest: () => {
      shardRequests += 1;
    },
  });
  await page.route("**/api/puzzle?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        date: "2026-06-10",
        start: "alpha",
        target: "beta",
        gap: 1,
      }),
    }),
  );
  await routeEmbedVectors(page, {
    alpha: [1, 0],
    beta: [0, 1],
  });

  await page.goto("/");
  await expect(page.locator("#guessInput")).toBeEnabled();

  await page.getByRole("button", { name: "Hard" }).click();

  await expect(page.locator("#message")).toContainText("Hard is unavailable");
  await expect(page.locator("#limitLabel")).toContainText("Easy max move: 0.67");
  await expect(page.getByRole("button", { name: "Easy" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Hard" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(shardRequests).toBe(0);
});

test("uses cached daily RelateBot paths without live path checking", async ({ page }) => {
  let embedRequests = 0;
  let shardRequests = 0;
  await routeTinyGameData(page, {
    dictionaryWords: [
      "alpha",
      "beta",
      "gamma",
      ...Array.from({ length: 1000 }, (_, index) => `dummyword${index}`),
    ],
    lexicon: {
      dim: 2,
      shardSize: 3,
      words: ["alpha", "beta", "gamma"],
      shards: ["data/vectors/000.bin"],
    },
    shard: Buffer.from(new Float32Array([1, 0, 0, 1, 0.7, 0.7]).buffer),
    onShardRequest: () => {
      shardRequests += 1;
    },
  });
  await page.route("**/api/puzzle?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        date: "2026-06-10",
        start: "alpha",
        target: "beta",
        gap: 1,
        easyPath: ["alpha", "gamma", "beta"],
        hardPath: null,
      }),
    }),
  );
  await page.route("**/api/embed", (route) => {
    embedRequests += 1;
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "embed should not be called" }),
    });
  });

  await page.goto("/");
  await expect(page.locator("#guessInput")).toBeEnabled();
  await expect(page.locator("#targetGap")).toHaveText("1.00 away");

  await page.getByRole("button", { name: "Give up" }).click();

  await expect(page.locator("#resultSolution")).toContainText(
    "RelateBot's solution: alpha -> gamma -> beta",
  );
  await expect(page.locator("#solutionPathList .path-word")).toContainText([
    "alpha",
    "gamma",
    "beta",
  ]);
  expect(embedRequests).toBe(0);
  expect(shardRequests).toBe(0);
});

test("reports malformed vector metadata instead of crashing", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await routeTinyGameData(page, {
    lexicon: {
      dim: 2,
      shardSize: 1,
      words: ["alpha", "omega"],
      shards: ["data/vectors/000.bin"],
    },
  });

  await page.goto("/");

  await expect(page.locator("#modelStatus")).toHaveText("Error");
  await expect(page.locator("#message")).toContainText("Vector metadata does not match");
  expect(pageErrors).toEqual([]);
});

test("reports a puzzle word with no loaded vector instead of crashing", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await routeTinyGameData(page);
  await page.route("**/api/puzzle?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        date: "2026-06-10",
        start: "alpha",
        target: "beta",
        gap: 1,
      }),
    }),
  );

  await page.goto("/");

  await expect(page.locator("#modelStatus")).toHaveText("Error");
  await expect(page.locator("#message")).toContainText('Puzzle word "beta" has no loaded vector');
  expect(pageErrors).toEqual([]);
});

test("loads the daily puzzle from the server API", async ({ page, request }) => {
  const today = pacificDateId();
  const response = await request.get(`/api/puzzle?date=${today}`);
  expect(response.ok()).toBeTruthy();
  const puzzle = await response.json();
  expect(Array.isArray(puzzle.easyPath)).toBeTruthy();
  expect(puzzle.easyPath[0]).toBe(puzzle.start);
  expect(puzzle.easyPath.at(-1)).toBe(puzzle.target);
  expect(Array.isArray(puzzle.hardPath)).toBeTruthy();
  expect(puzzle.hardPath[0]).toBe(puzzle.start);
  expect(puzzle.hardPath.at(-1)).toBe(puzzle.target);

  await page.goto("/?mockModel=1");

  await expect(page.locator("#startWord")).toHaveText(puzzle.start);
  await expect(page.locator("#targetWord")).toHaveText(puzzle.target);
  await expect(page.locator("#startGapLabel")).toHaveText(
    `Starting distance: ${puzzle.gap.toFixed(2)}`,
  );
  await expect(page.locator("#guessInput")).toBeFocused();
});

test("records and summarizes analytics events", async ({ request }) => {
  const today = pacificDateId();
  const sessionId = randomUUID();
  const response = await request.post("/api/analytics", {
    data: {
      type: "guess",
      sessionId,
      kind: "daily",
      mode: "easy",
      puzzleDate: today,
      outcome: "accepted",
      stepCount: 1,
      stepGap: 0.2,
      targetGap: 0.5,
    },
  });
  expect(response.status()).toBe(204);

  await expect
    .poll(async () => {
      const summaryResponse = await request.get(
        `/api/analytics?date=${today}&sessionId=${sessionId}`,
      );
      expect(summaryResponse.ok()).toBeTruthy();
      const summary = await summaryResponse.json();
      return {
        events: summary.eventCount,
        accepted: summary.guesses.accepted,
        sessions: summary.sessionCount,
      };
    })
    .toEqual({ events: 1, accepted: 1, sessions: 1 });
});

test("returns dictionary word vectors through the Pages Function", async ({ request }) => {
  const response = await request.post("/api/embed", {
    data: { word: "zymurgy" },
  });
  expect(response.ok()).toBeTruthy();

  const payload = await response.json();
  expect(payload.word).toBe("zymurgy");
  expect(payload.vector).toHaveLength(300);
  expect(payload.vector.some((value) => value !== 0)).toBeTruthy();
});

test("returns batch-shaped vectors for a one-word batch request", async ({ request }) => {
  const response = await request.post("/api/embed", {
    data: { words: ["zymurgy"] },
  });
  expect(response.ok()).toBeTruthy();

  const payload = await response.json();
  expect(payload.vectors.zymurgy).toHaveLength(300);
  expect(payload.word).toBeUndefined();
  expect(payload.vector).toBeUndefined();
});

test("uses real fastText vectors for generated endpoint words", async ({ request }) => {
  const response = await request.post("/api/embed", {
    data: { words: ["sonny", "another"] },
  });
  expect(response.ok()).toBeTruthy();

  const payload = await response.json();
  const similarity = cosineSimilarity(payload.vectors.sonny, payload.vectors.another);
  expect(1 - similarity).toBeGreaterThan(0.45);
});

test("endpoint data uses a specific but recognizable frequency band", async ({ request }) => {
  const manifestResponse = await request.get("/data/manifest.json");
  const endpointsResponse = await request.get("/data/endpoints.json");
  const blockedResponse = await request.get("/data/blocked-words.json");
  expect(manifestResponse.ok()).toBeTruthy();
  expect(endpointsResponse.ok()).toBeTruthy();
  expect(blockedResponse.ok()).toBeTruthy();

  const manifest = await manifestResponse.json();
  const endpoints = await endpointsResponse.json();
  const blocked = await blockedResponse.json();
  expect(manifest.endpointMinFrequencyRank).toBe(2500);
  expect(manifest.endpointMaxFrequencyRank).toBe(12000);
  expect(manifest.blockedWords).toBe(blocked.words.length);
  expect(manifest.vectorDim).toBe(300);
  expect(manifest.vectorWords).toBe(manifest.dictionaryWords);
  expect(endpoints.words.length).toBe(manifest.endpointWords);

  for (const word of ["the", "time", "people", "world", "water", "system", "plats", "sexuality"]) {
    expect(endpoints.words).not.toContain(word);
  }
  for (const word of endpoints.words) {
    expect(blocked.words).not.toContain(word);
  }
});
