# Montréallion

[![CI](https://github.com/SMLG120/montreallion/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SMLG120/montreallion/actions/workflows/ci.yml) [![Vercel](https://img.shields.io/website?url=https%3A%2F%2Fmontreallion.vercel.app%2Fapi%2Fhealth&label=vercel&logo=vercel&up_message=live&down_message=down)](https://montreallion.vercel.app)

A bilingual (EN/FR) Montréal rarity trivia game. Seven stops, 25 seconds each: name a valid answer, and the rarer it is, the more it scores (10–100).

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # unit tests
npm run test:e2e     # Playwright (first run: npx playwright install chromium)
```

Architecture, decisions, data provenance and roadmap are in [`docs/PROJECT_STATE.md`](docs/PROJECT_STATE.md).

Seed answers come from public sources (STM, City of Montréal, Wikipedia, CC BY-SA 4.0 for facts reused); see `data/seed/questions.json` for per-question provenance.
