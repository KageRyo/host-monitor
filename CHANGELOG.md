# Changelog

## Unreleased

## 0.1.0 — 2026-10-14

First published release of Host Monitor. Earlier development version labels were not published releases; this entry describes the complete initial release.

### Monitoring and dashboard

- Self-hosted IPv4 ICMP reachability checks with configurable intervals, bounded probe concurrency, and manual single-host or all-host checks.
- Grouped cards with response times, cumulative uptime, a rolling 60-entry heartbeat history, online/offline filters, light/dark themes, and a responsive Traditional Chinese interface.
- Host creation, editing, deletion, custom categories, notes, and persisted category ordering that survives mode exit, polling, and reload; failed saves restore the persisted order.
- Distinguish confirmed `up`/`down` from `unknown` and probe execution `error`; failed measurements remain visible but do not count as downtime or affect uptime counters. Preserve genuine no-reply results, including Windows destination-unreachable responses.
- Unchecked hosts show `—`; `stats.avgUptime` is `null` before any confirmed checks. Preserve valid 0ms RTTs.
- Handle HTTP, persistence, proxy, and network failures without misleading success messages or discarded form state.

### Configuration, storage, and access

- Configurable IPv4 `HOST` binding (default `0.0.0.0`), validated port/interval settings, and binding-aware startup URLs.
- Opt-in HTTP Basic authentication protecting the complete dashboard and all APIs; reject misconfigured credentials and cross-site browser writes. Document HTTPS reverse-proxy deployment and a proxy-only alternative.
- Local JSON storage with atomic writes, rollback on failed persistence, and complete record/schema validation before loading. Invalid or unreadable existing data stops startup, preserves the original, and attempts a recoverable archival copy.
- Valid legacy files normalize optional fields, category aliases, and group ordering. No real monitor inventory or credentials are bundled.
- Configurable monitor caps and process-wide manual-check quotas with actionable 409/429 responses.
- Rotating logs and Linux helpers that verify process start time, cwd, and the Node entrypoint before signaling; clean stale records without terminating unrelated processes.

### Notifications

- Opt-in generic JSON webhooks for successfully persisted reachability transitions, with bounded delivery, timeouts, and redacted failure logs.
- Optional one-time initial-down alerts with a configurable consecutive-failure threshold; persist progress across restart, reset it on execution errors, and roll back failed writes.
- Measurement errors never trigger reachability alerts; retain the last confirmed state across errors and reloads. Notifications have no cooldown or durable retry queue.

### Demo, documentation, and verification

- Public GitHub Pages demo with synthetic hosts, browser-local persistence, simulated checks, and reset; entered addresses are never contacted.
- Bundled CSS, inline SVG icons, and system fonts for offline self-hosted operation without runtime CDN dependencies.
- English and Traditional Chinese READMEs, dashboard screenshot, configuration/recovery guidance, and Release, CI, and SonarCloud badges.
- Node.js integration tests for real backend behavior, configuration, storage, probes, notifications, demo semantics, and Linux helpers; browser regressions for authenticated real-backend flows, errors/recovery, and category-order races.
- Compatible runtime dependency security updates and pinned GitHub Actions for verification and Pages deployment.

### Deployment notes

- Authentication is disabled by default for trusted-network compatibility. Network binding and rate limits do not authenticate callers; enable authentication and use HTTPS before remote access.
- API consumers must handle `status: "error"`, `checkError: "probe_execution_failed"`, `stats.error`, nullable uptime, and error history entries with `alive: null`.
- Keep backups. Invalid persisted data requires deliberate repair or a verified backup before restarting.
- Runtime dependency audit is clean at release preparation. Seven build-only Tailwind dependency advisories remain; npm's proposed remediation requires a Tailwind v4 migration.
