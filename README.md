# The Relating Game

A word game by Dhruv Saini. Start with one word and reach a target word through a chain of related meanings. Each move must be close enough to the previous word in a word-embedding space.

[Play the game](https://relating-game.pages.dev/) · [Video demonstration](https://drive.google.com/file/d/1FhOEWrFZQKOaWhtqX9v4ZyAvTKfGtIrm/view)

## What I built

The browser game, move validation and scoring, daily puzzles and archive, local progress saving, and the Cloudflare Pages/Workers backend are in this repository. The interface shows the distance of each move and the remaining distance to the target.

The word vectors come from fastText; I did not train the underlying embedding model. Dictionaries, frequency lists and blocked-word lists also have external sources. See [data attribution](public/data/ATTRIBUTION.md).

## Source guide

- [public/app.js](public/app.js): gameplay, vector loading, similarity calculations and browser state.
- [public/index.html](public/index.html) and [public/styles.css](public/styles.css): the interface.
- [functions/api](functions/api): Cloudflare Pages API endpoints.
- [workers/daily](workers/daily): daily-puzzle worker.
- [scripts](scripts): data preparation and daily-puzzle tooling.
- [tests/game.spec.js](tests/game.spec.js): browser tests.

## Run locally

Use a recent Node.js release supported by the pinned Wrangler version.

```bash
git clone https://github.com/dhruv9saini/the-relating-game.git
cd the-relating-game
npm ci
npm run dev
```

Open http://127.0.0.1:8788. The development command seeds the local daily puzzle and starts Cloudflare Pages locally. The prepared dictionary and vector data are included in the repository.

For a static preview without the Pages API, use `npm run serve`. Use `npm run dev` for the full local application.

## Browser tests

```bash
npx playwright install chromium
npm test -- --workers=1
```

The test configuration starts the local development server. Some tests use the app's explicit mock-model mode; the live game uses the prepared fastText vectors.
