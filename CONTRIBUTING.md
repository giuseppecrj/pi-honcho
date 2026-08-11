# Contributing to Pi Honcho

Thank you for helping improve Pi Honcho. This guide covers local setup, workflow, style, tests, and privacy rules for public contributions.

## Setup

1. Install Node.js 24 or later.
2. Clone the repository and install dependencies:

```bash
npm ci
```

1. Confirm the package loads in Pi:

```bash
./node_modules/.bin/pi -e . --list-models
```

Keep Honcho API keys and other secrets out of the repository, chat logs, and session files. Use your shell environment or a local secret store.

## Branch and pull request workflow

1. Create a branch from `main` for one focused change.
2. Make the smallest change that solves the problem.
3. Run the required checks below before you open a pull request.
4. Open a pull request against `main` with a short summary of the change and how you verified it.
5. Keep discussion on the public pull request. Do not paste secrets, credentials, or private user data into issues or reviews.

## Code style

- Follow the existing TypeScript patterns and project terminology.
- Keep modules focused. Prefer small public seams over new internal helpers that only serve tests.
- Do not invent speculative configuration, factories, or abstractions.
- Format and lint with Biome through the project scripts. Do not reformat unrelated files.

## Tests

- Test through public seams: delivery ledger entries, registered lifecycle handlers with a fake `ExtensionAPI`, the SDK adapter factory, and captured `registerTool` definitions.
- Reach private coordinator behavior through those seams. Do not export private helpers only for tests.
- Add or update focused tests for the behavior you change.
- Do not log real secrets, personal data, or full production session contents in tests.

## Privacy and secrets

- Never commit API keys, tokens, private keys, `.env` files, or real user conversation content.
- Treat recognized secrets as a hard stop: reject the whole exchange and do not log the detected value.
- Prefer synthetic fixtures. If a report needs sensitive context, redact it first.
- Keep Honcho credentials outside Pi chat and session files.

## Required checks

Run these from the repository root before you open or update a pull request:

```bash
npm run check
npm run verify
./node_modules/.bin/pi -e . --list-models
```

- `npm run check` — Biome format, import organization, and lint.
- `npm run verify` — type check, lint, and all tests.
- `./node_modules/.bin/pi -e . --list-models` — package load smoke check through Pi.

## Pull request checklist

- [ ] Branch is based on current `main`.
- [ ] Change is focused and documented in the pull request description.
- [ ] Public-seam tests cover the new or fixed behavior.
- [ ] No secrets, credentials, or private user data appear in the diff or discussion.
- [ ] `npm run check` passes.
- [ ] `npm run verify` passes.
- [ ] `./node_modules/.bin/pi -e . --list-models` succeeds.
