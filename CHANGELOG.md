# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.3.0](https://github.com/giuseppecrj/pi-honcho/compare/v0.2.1...v0.3.0)

Performance release. Session startup and `/reload` no longer parse the entire session history for reset recovery (raw-byte marker pre-filter; measured 1,155 files scanned with only 2 parsed, ~12ms instead of multi-second CPU). Per-turn hooks now use incremental entry tracking, a stat-gated standing-instructions cache, and a cached, budget-correct memory context. `session_search` keeps its SQLite handle and clean-file index across calls. New `HONCHO_DEBUG=1` (plus optional `HONCHO_DEBUG_FILE`) writes provenance logs with timings and counters for startup, delivery, and cache behavior. Nested skills are now fully manageable (view, patch, delete) within their root, and the test suite is hermetic — `npm test` can no longer write to the real `~/.pi/agent/honcho-memory.json` or `~/.honcho/config.json` (users bitten by the previous behavior should run `/honcho init` once to re-link).

### Merged

- perf: eliminate startup session-scan and hot-path costs, add HONCHO_DEBUG provenance logging [`#7`](https://github.com/giuseppecrj/pi-honcho/pull/7)

### Commits

- perf(remote): cut startup, per-turn, and recovery hot-path costs [`80a542f`](https://github.com/giuseppecrj/pi-honcho/commit/80a542f5adfeb5e943bd0a31cc74cdb915a2c076)
- perf(local): cache hot paths for standing instructions, session search, and skills [`26ab814`](https://github.com/giuseppecrj/pi-honcho/commit/26ab814baf1b9b8af238870f75f9cc79e3a0d0ac)
- fix: address perf review findings [`dbe63f5`](https://github.com/giuseppecrj/pi-honcho/commit/dbe63f5591dfcd9ca95ab8a9d48e243710772a9c)
- feat: add HONCHO_DEBUG provenance logging [`a481810`](https://github.com/giuseppecrj/pi-honcho/commit/a4818105b219028aacab93c920412ce032dcccf3)
- fix: allow nested skill deletion within root [`864ec73`](https://github.com/giuseppecrj/pi-honcho/commit/864ec738dcdb5c192755a283fcf1742ff6e24e76)
- fix(test): pin agent dirs so tests cannot write real user state [`5131870`](https://github.com/giuseppecrj/pi-honcho/commit/5131870d1f112283d4dfe092b19b11ef93ea2820)

## [v0.2.1](https://github.com/giuseppecrj/pi-honcho/compare/v0.2.0...v0.2.1) - 2026-09-04

### Commits

- fix: support workspace-scoped Honcho API keys [`a046a28`](https://github.com/giuseppecrj/pi-honcho/commit/a046a28b65ba9e0e6608e970ed6b20627ef3cbe9)
- docs: add release workflow skill [`9f55ba2`](https://github.com/giuseppecrj/pi-honcho/commit/9f55ba2f31c7595dd164c2a1f5ce6e8603c8e21f)
- docs: add v0.2.0 release notes [`4986d54`](https://github.com/giuseppecrj/pi-honcho/commit/4986d545a7f429fc98652c424d9d9ae1a9744876)

## [v0.2.0](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.9...v0.2.0) - 2026-08-17

### Commits

- feat: add browser OAuth sign-in [`ace29b9`](https://github.com/giuseppecrj/pi-honcho/commit/ace29b915fbe520112e261b0823386b440d03ec3)

## [v0.1.9](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.8...v0.1.9) - 2026-08-17

### Commits

- feat: make repository memory explicit [`d581193`](https://github.com/giuseppecrj/pi-honcho/commit/d5811938c6df78c7bdcb958054ebf3b29dd43f0f)
- feat: simplify Honcho command surface [`1fadb97`](https://github.com/giuseppecrj/pi-honcho/commit/1fadb97bc7f989295df7d11d1ac4139f75ac808f)
- docs: add agent guidance [`cb5627e`](https://github.com/giuseppecrj/pi-honcho/commit/cb5627e60484d892fcbb54e55e35c043db12e390)
- chore: configure triage labels [`34a7215`](https://github.com/giuseppecrj/pi-honcho/commit/34a7215918b0a21ee54ba1b2321c5556d772c320)
- docs: clarify repository memory status [`3d7ccf7`](https://github.com/giuseppecrj/pi-honcho/commit/3d7ccf77be65d1b2a4a98a125f961f470ae69013)

## [v0.1.8](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.7...v0.1.8) - 2026-08-17

### Commits

- refactor: separate local and remote memory modules [`6271fde`](https://github.com/giuseppecrj/pi-honcho/commit/6271fde203de156022481bc02ab5b463e57dc41b)
- style: format refactor tests [`f511d1e`](https://github.com/giuseppecrj/pi-honcho/commit/f511d1ec76cc4554b97b7e54abcac635b4401ce4)

## [v0.1.7](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.6...v0.1.7) - 2026-08-16

### Commits

- Validate Honcho workspace IDs [`a72159e`](https://github.com/giuseppecrj/pi-honcho/commit/a72159e48cc32e3158debdc8b6db8bcaae9d071b)

## [v0.1.6](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.5...v0.1.6) - 2026-08-13

### Commits

- fix: isolate Honcho memory from Herdr subagents [`ef77b52`](https://github.com/giuseppecrj/pi-honcho/commit/ef77b523f1b5ebbc599a3d59a17bd5ce8aedd567)

## [v0.1.5](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.4...v0.1.5) - 2026-08-13

### Commits

- fix: stop injecting inferred user profiles [`6dc5f71`](https://github.com/giuseppecrj/pi-honcho/commit/6dc5f7117f429416161378659fb749d6055ab622)

## [v0.1.4](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.3...v0.1.4) - 2026-08-12

### Commits

- docs: replace lifecycle chart with image [`261850b`](https://github.com/giuseppecrj/pi-honcho/commit/261850b4bb4daa8fdbf100242e44162014fdd912)
- docs: add gallery cover to readme [`411ab79`](https://github.com/giuseppecrj/pi-honcho/commit/411ab793c27b8243cac0defd2a95ce81123b98e8)

## [v0.1.3](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.2...v0.1.3) - 2026-08-11

### Commits

- chore: automate changelog generation [`998612b`](https://github.com/giuseppecrj/pi-honcho/commit/998612b6dbcd3e7bf959ccf8c5b0bab8c19f5902)
- fix: store managed skills under pi-honcho [`201f700`](https://github.com/giuseppecrj/pi-honcho/commit/201f700b77e315236232720ed6e4389e5f37d4d4)

## [v0.1.2](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.1...v0.1.2) - 2026-08-11

### Commits

- feat: add Pi package gallery artwork [`604b464`](https://github.com/giuseppecrj/pi-honcho/commit/604b464e0eeed7df219f8baf5cbb82af0cd821a9)

## [v0.1.1](https://github.com/giuseppecrj/pi-honcho/compare/v0.1.0...v0.1.1) - 2026-08-11

### Commits

- ci: publish releases with npm OIDC [`12c54ff`](https://github.com/giuseppecrj/pi-honcho/commit/12c54ff5a0d637b80c41caf6e8ad29b97f10d940)
- feat: show Honcho workspace in footer [`53754ba`](https://github.com/giuseppecrj/pi-honcho/commit/53754ba2de6bbbc3b01661d002e0665666ae811c)

## v0.1.0 - 2026-08-11

### Commits

- feat: launch Pi Honcho [`00b19a2`](https://github.com/giuseppecrj/pi-honcho/commit/00b19a242b520d566b8a685d15ed78195c2a09a7)
