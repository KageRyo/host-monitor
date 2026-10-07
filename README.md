# Host Monitor

[正體中文](README_TW.md)

A lightweight, self-hosted dashboard for checking whether servers, NAS devices, printers, and other IPv4 hosts are reachable. Host Monitor runs ICMP ping checks from your server and displays status, response time, uptime, and recent check history in a browser.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![Storage](https://img.shields.io/badge/storage-local_JSON-blue)](#data-and-logs)
[![GitHub stars](https://img.shields.io/github/stars/KageRyo/host-monitor?style=flat)](https://github.com/KageRyo/host-monitor/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/KageRyo/host-monitor)](https://github.com/KageRyo/host-monitor/commits)

## At a glance

| Feature | Behavior |
| --- | --- |
| Reachability checks | ICMP ping every 30 seconds by default, with manual checks for one or all hosts |
| Dashboard | Grouped status cards, response times, uptime percentages, and heartbeat history |
| Host management | Add, edit, and remove IPv4 targets with names, categories, and notes |
| Organization | Custom category order and online/offline filters |
| Appearance | Light and dark themes; the current interface uses Traditional Chinese |
| Storage | Local JSON file; no database service required |

Uptime is the percentage of successful recorded checks. Each host retains its latest 60 history entries, while its cumulative check counters are stored separately. A successful ping indicates network reachability; it does not verify the health of an HTTP service or application.

## Quick start

You need Node.js 18 or newer, npm, and a working system `ping` command. The Bash helpers also require `setsid` and standard Linux process utilities; use `npm start` for foreground execution on other platforms with a compatible ping utility.

```bash
git clone https://github.com/KageRyo/host-monitor.git
cd host-monitor
npm ci --omit=dev
npm start
```

Open `http://localhost:3000`. The application starts with an empty monitor list. Use **新增主機** (Add host) to enter an IPv4 address, name, category, and optional notes.

For background execution on Linux:

```bash
./start.sh
./stop.sh
```

`start.sh` prints the local URL and stores the process ID in `logs/server.pid`. LAN URLs are recorded in `logs/monitor.log`.

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

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listening port |
| `CHECK_INTERVAL` | `30000` | Interval between automatic checks, in milliseconds |
| `LOG_MAX_BYTES` | `5242880` | Log rotation threshold in bytes (5 MiB) |
| `LOG_MAX_FILES` | `5` | Number of rotated log backups; `0` discards the previous log on rotation |
| `LOG_TO_STDOUT` | `true` in a terminal, otherwise `false` | Also print application logs to the console |

The example `.env` explicitly sets `LOG_TO_STDOUT=false`. The server loads `.env` directly without an additional dotenv dependency.

## Data and logs

- `data/monitors.json` stores targets, notes, category order, cumulative check counters, and recent history.
- `logs/monitor.log` stores application logs, with rotated backups named `monitor.log.1` through `monitor.log.5` by default.
- `logs/startup.log` captures startup output when using `start.sh`.

Both `data/` and `logs/`, along with local environment files, are ignored by Git. Back up `data/monitors.json` if you need to preserve your configuration and counters. With the default check interval, 60 history entries cover approximately 30 minutes.

To follow application logs:

```bash
tail -f logs/monitor.log
```

## Deployment

Run Host Monitor on a machine that can reach the devices you want to check. The HTTP server listens on `0.0.0.0`, so it is accessible through the host's network interfaces when the firewall permits it.

The current application has no built-in authentication. Use it on a trusted network, or place it behind an authenticated reverse proxy when remote access is needed.

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

Demo changes are saved in the visitor's browser using a separate localStorage key. **重設 Demo** (Reset demo) restores the sample hosts. If browser storage is unavailable, the demo works in memory and resets on reload. Styling, icons, and fonts still load from external CDNs.

Build and preview without installing backend dependencies:

```bash
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

The backend uses Express 5 and the `ping` package. The dashboard uses vanilla JavaScript, Tailwind CSS, and Font Awesome. Frontend styling, icons, and fonts currently load from external CDNs.

```bash
npm install
npm test
node --check server.js
npm start
```

`npm test` runs the demo transport tests using Node.js's built-in test runner. They cover synthetic status totals, host management, IPv4 validation, persistence, history limits, category ordering, reset, malformed requests, and unavailable storage. Browser verification requires Node.js 20 or newer. The browser check covers rendering under the Pages subpath, host management, filtering, themes, persistence, manual and automatic checks, category ordering, reset, mobile layout, disabled storage, and the normal API transport:

```bash
npm ci
npx playwright install chromium
npm run test:browser
```

To use an existing Chrome installation, set `CHROME_PATH` to its executable path instead of installing Chromium. Real ping behavior requires a reachable self-hosted target.

## License

[MIT](LICENSE) © 2026 Chien-Hsun Chang.
