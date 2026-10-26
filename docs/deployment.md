# Deployment

## Binary

Build with Go 1.27.3 (`go build -o host-monitor .`), or extract the release archive
for your operating system and architecture. Go embeds the checked-in frontend;
you do not need Node.js/npm. Linux probes execute the system `/bin/ping` directly
instead of searching PATH. Linux also needs `iputils-ping` (Debian/Ubuntu:
`sudo apt install iputils-ping`). Windows uses its native IP Helper API.

Run `./host-monitor` (Windows: `.\host-monitor.exe`) from the existing installation
directory. The default state paths are `.env`, `data/monitors.json` and
`logs/monitor.log`. For an explicit path, run `host-monitor --dir /srv/host-monitor`.
Process environment overrides `.env`. Existing settings in `.env.example` apply.
Back up configuration/data and stop the old process before switching. Do not run
multiple instances against one state file. The JSON file remains usable by Node.

The default IPv4 listener is `0.0.0.0:3000`; use Basic auth or an authenticated HTTPS
reverse proxy for remote access, as described in the README. Ctrl+C/SIGTERM drains
the service. The Linux helpers require the binary at `./host-monitor`, `setsid`,
and `/proc`; they record PID/start-time/executable identity. They never stop a
legacy Node instance or an unrelated process. Stop those through their original
process manager before upgrading. After replacing a binary while running,
`/proc/PID/exe` can have a `(deleted)` suffix; stop the service before replacing it.

Example systemd unit (create a dedicated `host-monitor` account and grant it write
access to `/var/lib/host-monitor`; install the binary in `/usr/local/bin`):

```ini
[Unit]
Description=Host Monitor
After=network.target

[Service]
User=host-monitor
WorkingDirectory=/var/lib/host-monitor
ExecStart=/usr/local/bin/host-monitor --dir /var/lib/host-monitor
Restart=on-failure
TimeoutStopSec=15
Environment=LOG_TO_STDOUT=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

Linux datagram ICMP requires the service's group ID to be within
`net.ipv4.ping_group_range` (`sysctl net.ipv4.ping_group_range`). Many distributions
already allow ordinary users. If not, the host administrator can allow the
service's GID through that setting. Do not grant the whole Go process root or
CAP_NET_RAW just to run probes. Tool errors appear separately in the dashboard.
Windows users can run the binary in the foreground or under their chosen service
manager with an explicit `--dir`; installing a Windows service is not automated.

## Docker Desktop / Docker Engine

```sh
docker compose up --build -d
docker compose logs monitor
docker compose down
```

The image uses a static Go binary, Alpine, CA certificates and iputils ping. It
runs as UID/GID 10001. Compose drops capabilities, enables no-new-privileges and
permits datagram ICMP for ordinary groups through a container network sysctl.
There is no Node runtime. The default bridged network must be able to reach the
target LAN; Docker Desktop/host firewall rules still apply. Do not use privileged
mode as a substitute for fixing network reachability.

Named volumes preserve `/app/data` and `/app/logs`; `down` retains them. Do not use
`down -v` unless you intend to erase monitoring data. To migrate an existing JSON
file, stop Node and copy it into the data volume before starting Go. Alternatively
bind-mount your existing data/log directories with ownership writable by 10001.
The optional host `.env` is passed to the container, never copied into the image.
Set `LOG_TO_STDOUT=true` to also see logs through Docker. Use `/api/health` for
health probes; supply Basic credentials when authentication is enabled.

## Builds and releases

```sh
python3 scripts/build-release.py --os linux --arch amd64
python3 scripts/build-release.py --os linux --arch arm64
python3 scripts/build-release.py --os windows --arch amd64
python3 scripts/build-release.py --os windows --arch arm64
```

The script selects `GOTOOLCHAIN=go1.27.3`, disables CGO, trims paths/VCS metadata
and build IDs, verifies repeated binary equality, and writes archives/checksums
under `dist/`. Go modules are pinned in `go.mod`/`go.sum`. Reproducibility means
identical inputs and toolchain produce identical artifacts; dependency, compiler,
asset and documentation changes intentionally change hashes. Container bases and
apk package repositories can change independently of deterministic Go builds.
CI tests on Linux and Windows before packaging; a `v*` tag publishes archives only
after all gates pass. Do not tag a migration before the intended release is approved.
