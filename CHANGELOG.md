# Changelog

## Unreleased

## 0.2.0 — 2026-10-08

- Omit framework disclosure headers and resolve backend SonarCloud review findings.
- Add isolated integration tests for the real Express backend, probe scheduling, persistence errors, configuration, Linux helpers, and generic webhooks.
- Fix reserved category keys, built-in/legacy category normalization, ordering deduplication, and malformed/non-object JSON validation.
- Validate HTTP port and check interval; preserve 0ms RTT when reloading saved results.
- **API compatibility:** `stats.avgUptime` is now `null` when no monitors have recorded checks; consumers must handle this value.
- Show unknown uptime as `—`, exclude unchecked hosts from averages, and return `stats.avgUptime: null` when no checks exist.
- Handle non-2xx, proxy, and network errors consistently in dashboard actions without success toasts or lost forms.
- Bound shared probe concurrency (default 5), prevent duplicate probes, cap new monitors (default 100), and rate-limit manual requests (default 10/minute) with 409/429 responses.
- Verify Linux process identity before TERM/KILL; remove broad process-name termination and clean stale PID records safely.
- Add opt-in generic JSON webhook notifications on persisted up/down transitions, with timeout, bounded delivery, and safe logs.
- Expand browser verification to cover real backend/data flows and error responses; document configuration and compatibility in both READMEs.

## 0.1.0

First tagged release of Host Monitor.

### Monitoring and dashboard

- Self-hosted IPv4 reachability checks using ICMP ping, with a configurable interval and manual single-host or all-host checks.
- Grouped status cards with response times, cumulative uptime percentages, and recent heartbeat history.
- Host creation, editing, and deletion with custom categories, category ordering, and notes.
- Online/offline filters, light and dark themes, and a responsive Traditional Chinese interface.
- Local JSON persistence, atomic data writes, corrupted-data backups, and rotating logs.

### Demo and documentation

- An interactive GitHub Pages demo with synthetic hosts, simulated checks, browser-local persistence, and reset.
- English and Traditional Chinese READMEs with direct demo links, a dashboard screenshot, setup instructions, and deployment guidance.
- Project metadata aligned with the `host-monitor` repository and the `0.1.0` release version.

### Verification

- Node.js tests for the demo transport and browser checks for dashboard interactions, persistence, mobile layout, and normal API routing.
- GitHub Actions tests, static-demo builds, and deployment from `main` using pinned actions.

The public demo simulates reachability. Real ping checks require a self-hosted server. The application has no built-in authentication; deployment guidance covers access on trusted networks and behind an authenticated reverse proxy.
