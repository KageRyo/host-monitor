# Changelog

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
