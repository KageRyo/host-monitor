# Host Monitor

[正體中文](README_TW.md) · [Demo](https://kageryo.github.io/host-monitor/)

A lightweight, self-hosted dashboard for checking whether servers, NAS devices, printers, and other IPv4 hosts are reachable. Host Monitor runs ICMP ping checks from your server and displays status, response time, uptime, and recent check history in a browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs\&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express\&logoColor=white)](https://expressjs.com/)
[![Storage](https://img.shields.io/badge/storage-local_JSON-blue)](#data-and-logs)
[![GitHub stars](https://img.shields.io/github/stars/KageRyo/host-monitor?style=flat)](https://github.com/KageRyo/host-monitor/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/KageRyo/host-monitor)](https://github.com/KageRyo/host-monitor/commits)

[![Host Monitor demo dashboard showing grouped synthetic hosts, uptime, response times, and heartbeat history](docs/images/demo-dashboard.png)](https://kageryo.github.io/host-monitor/)

## At a glance

| Feature             | Behavior                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Reachability checks | ICMP ping every 30 seconds by default, with manual checks for one or all hosts                                    |
| Dashboard           | Grouped status cards, response times, uptime percentages, and heartbeat history                                   |
| Host management     | Add, edit, and remove IPv4 targets with names, categories, and notes                                              |
| Organization        | Custom category order and online/offline filters                                                                  |
| Appearance          | Light and dark themes; the current interface uses Traditional Chinese                                             |
| Storage             | Local JSON file; no database service required                                                                     |
| Offline frontend    | Locally generated CSS, inline SVG icons, and system fonts; no external CSS, icon, or font CDN required at runtime |

Uptime is the percentage of successful recorded checks. Each host retains its latest 60 history entries, while its cumulative check counters are stored separately. A successful ping indicates network reachability; it does not verify the health of an HTTP service or application.

Unchecked hosts show `—` for uptime and are excluded from the global average. If every host is unchecked, the average also shows `—`.

## Quick start

You need Node.js 18 or newer, npm, and a working system `ping` command. The Bash helpers also require `setsid` and standard Linux process utilities; use `npm start` for foreground execution on other platforms with a compatible ping utility.

```bash
git clone https://github.com/KageRyo/host-monitor.git
cd host-monitor
npm ci --omit=dev --ignore-scripts
npm start
```

Open `http://localhost:3000`. The application starts with an empty monitor list. Use **新增主機** (Add host) to enter an IPv4 address, name, category, and optional notes.

For background execution on Linux:

```bash
./start.sh
./stop.sh
```

`start.sh` prints the local URL and stores the process ID in `logs/server.pid` and process start time in `logs/server.identity`. LAN URLs are recorded in `logs/monitor.log`.

Before signaling, the helpers verify process start time, cwd, and the Node entrypoint. Stale or mismatched records are cleaned without signaling unrelated processes. Before upgrading, stop the old service through its existing process manager; the new helpers refuse to kill legacy processes without an identity record.

## Add targets from a file

You can manage targets in the dashboard, or prepare the data file before starting the server:

```bash
mkdir -p data
cp monitors.example.json data/monitors.json
```

Edit the sample addresses and names to match your devices. Stop the server before editing `data/monitors.json` manually, then restart it to load your changes.

Only IPv4 addresses are accepted by the dashboard API. Hostnames and IPv6 addresses are not currently supported.

## Configuration

Copy [.env.example](.env.example) to `.env` to customize the defaults. Existing process environment variables take precedence over values in `.env`.

| Variable             | Default                                 | Purpose                                                                     |
| -------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `PORT`               | `3000`                                  | HTTP listening port, 1–65535                                                |
| `CHECK_INTERVAL`     | `30000`                                 | Automatic check interval, 1000–2147483647 milliseconds                      |
| `LOG_MAX_BYTES`      | `5242880`                               | Log rotation threshold in bytes (5 MiB)                                     |
| `LOG_MAX_FILES`      | `5`                                     | Number of rotated log backups; `0` discards the previous log on rotation    |
| `LOG_TO_STDOUT`      | `true` in a terminal, otherwise `false` | Also print application logs to the console                                  |
| `PROBE_CONCURRENCY`  | `5`                                     | Shared automatic/manual ping concurrency limit                              |
| `MAX_MONITORS`       | `100`                                   | Limit on new monitors; existing excess data remains monitored               |
| `MANUAL_CHECK_LIMIT` | `10`                                    | Process-wide manual requests per 60 seconds, shared by both check endpoints |
| `WEBHOOK_ENABLED`    | `false`                                 | Enable generic JSON webhook notifications                                   |
| `WEBHOOK_URL`        | Empty                                   | HTTP/HTTPS receiver URL                                                     |
| `WEBHOOK_TIMEOUT_MS` | `5000`                                  | Notification timeout, 1–2147483647 milliseconds                             |

Invalid integer settings fall back to defaults with a warning. Concurrency, monitor cap, and manual quota must be positive integers.

The example `.env` explicitly sets `LOG_TO_STDOUT=false`. The server loads `.env` directly without an additional dotenv dependency.

## Check limits and API behavior

Automatic and manual checks share one queue; probes for the same monitor never overlap. All-host checks share any existing single-host work. Duplicate single/all checks return `429`. Manual requests use a process-wide fixed 60-second window, including rejected duplicate requests; exhausted quotas return `429` with `Retry-After`. Automatic checks do not consume the manual quota. Adding beyond the monitor cap returns `409`; editing and deleting remain available.

Creating/updating monitors and saving group order require a JSON object. Missing, malformed, or non-object bodies return `400 { error }`. `stats.avgUptime` is a number or `null`; `null` means no recorded checks, while 0 means 0%. Failed check writes restore status, history, and counters; those checks do not contribute to uptime, and only persisted results trigger notifications. Built-in category labels normalize to `server`, `nas`, `printer`, and `edge`. Legacy data normalizes on load and is written back on the next successful save.

## Webhook notifications

Set `WEBHOOK_ENABLED=true` and `WEBHOOK_URL`, then restart. After successfully persisting a result, the server sends only `up→down` and `down→up` transitions. Initial unknown states, unchanged states, and the demo do not send notifications. An HTTP/HTTPS receiver gets this generic JSON:

```json
{"event":"monitor.status_changed","monitor":{"id":"192-0-2-1","ip":"192.0.2.1","name":"Router","group":"server"},"previousStatus":"up","status":"down","checkedAt":"2026-10-08T00:00:00.000Z","responseTime":null}
```

Delivery runs in the background with two workers and up to 100 waiting events. Queue overflow drops new events with a warning. Timeouts and HTTP failures do not block monitoring and are not retried; restarts discard waiting events. Invalid URLs disable notifications with a safe warning. URLs, tokens, and response bodies are never logged. This version has no failure threshold, cooldown, or durable redelivery. Discord/Slack require a bridge that accepts generic JSON.

## Data and logs

* `data/monitors.json` stores targets, notes, category order, cumulative check counters, and recent history.
* `logs/monitor.log` stores application logs, with rotated backups named `monitor.log.1` through `monitor.log.5` by default.
* `logs/startup.log` captures startup output when using `start.sh`.

Both `data/` and `logs/`, along with local environment files, are ignored by Git. Back up `data/monitors.json` if you need to preserve your configuration and counters. With the default check interval, 60 history entries cover approximately 30 minutes.

To follow application logs:

```bash
tail -f logs/monitor.log
```

## Deployment

Run Host Monitor on a machine that can reach the devices you want to check. The HTTP server listens on `0.0.0.0`, so it is accessible through the host's network interfaces when the firewall permits it.

The current application has no built-in authentication. These limits protect one process and do not replace authentication. Use it on a trusted network, or place it behind an authenticated reverse proxy when remote access is needed.

For a process manager, run `server.js` directly. For example, with [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start server.js --name host-monitor
pm2 save
pm2 startup
```

Follow the command printed by `pm2 startup` to configure startup on your system.

## Interactive demo

The static demo reuses the dashboard with eight synthetic hosts, mixed online/offline states, and simulated checks every 30 seconds. You can add, edit, and delete hosts, run manual checks, reorder categories, filter statuses, and switch themes. **No entered address is contacted.** A visible banner distinguishes the demo from a real monitoring deployment.

Demo changes are saved in the visitor's browser using a separate localStorage key. **重設 Demo** (Reset demo) restores the sample hosts. If browser storage is unavailable, the demo works in memory and resets on reload.

Styling is generated locally with Tailwind CSS, icons use inline SVGs, and fonts use the system font stack. The demo does not require external CSS, icon, or font CDNs at runtime.

Build and preview the demo locally:

```bash
npm install
npm run build:demo
python3 -m http.server 8080 --directory demo-dist
```

Open `http://localhost:8080`. For a self-hosted installation, `http://localhost:3000/?demo=1` also opens the simulation; opening the normal URL uses the real API.

### Publish on GitHub Pages

The [Demo Pages workflow](.github/workflows/demo-pages.yml) tests and builds the demo on pull requests. It publishes only the generated frontend assets on a push to `main` or a manual run on `main`.

1. In the repository, open **Settings → Pages** and select **GitHub Actions** as the source.
2. Merge the demo change into `main`, or run **Actions → Demo Pages → Run workflow** on `main` if it is already merged.
3. After a successful deployment, open [the demo](https://kageryo.github.io/host-monitor/).

The URL becomes available after Pages is enabled and the first deployment succeeds. See [GitHub's custom workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) for setup details. Real ICMP checks and the Node.js API still require a self-hosted server.

## Development

The backend uses Express 5 and the `ping` package. The dashboard uses vanilla JavaScript and Tailwind CSS, with locally generated CSS, inline SVG icons, and system fonts. No external CSS, icon, or font CDN is required at runtime.

Install the development dependencies:

```bash
npm install
```

To regenerate the stylesheet after changing frontend styles, run:

```bash
npm run build:css
```

The demo build runs this CSS build automatically and copies the required frontend assets into `demo-dist/`:

```bash
npm run build:demo
```

Run the tests and start the server during development:

```bash
npm test
node --check server.js
npm start
```

`npm test` uses Node.js’s built-in runner for separate backend, demo, configuration, scheduler, Linux helper, and webhook suites. Backend data lives in temporary directories, probes are mocked, and notifications use local HTTP receivers; no real ICMP or external service is needed. CI also runs `npm run test:browser` for demo interactions, real API/data flows, and failure UI.

## License

[MIT](LICENSE) © 2026 Chien-Hsun Chang.
