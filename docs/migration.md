# Go migration

The production entrypoint is `main.go`. It embeds the unchanged `public/`
assets, so a released executable does not need Node, npm, a frontend build, or
separate asset files. HTTP, persistence, scheduler, configuration and notifications
live in `internal/monitor`, split by responsibility. The only direct Go dependency
is `golang.org/x/text`, pinned for Traditional Chinese collation. No database or
additional service is used.

## Compatibility and rollout

The pre-migration contract is in [migration-contract.md](migration-contract.md).
`data/monitors.json` keeps its original JSON schema. Both implementations can
read each other's persisted state, including legacy defaults, cumulative counters,
60-entry history and initial-down progress. Stop the old service, back up `data/`
and `.env`, then start Go with the same working directory (or `--dir /path`).
Never run both implementations against the same data file. Monitor creation does
not initiate a probe; the initial timer and configured interval retain their
original behavior. Frontend code, styling, theme and filters are unchanged.

The original Node backend files, dependencies and automated tests remain as a
reference and rollback path: `npm ci --include=dev --ignore-scripts` then
`npm run start:legacy`. Stop Go first. These dependencies are development-only;
the executable, release archives and production Docker image exclude Node.
No version bump or release publication is part of the migration itself.

State changes and disk writes are serialized under one mutex. Each probe runs
outside it; a single bounded FIFO queue coalesces work by monitor identity.
No probe worker goroutines run while idle. Deleting and re-adding an IP does not
adopt an old result. Cancellation releases queued jobs and waits for active jobs.
Results are written to a same-directory temporary file, synced, then replaced;
failed persistence restores memory and suppresses webhooks. This sync provides
stronger write durability than the old implementation and costs filesystem I/O.
Shutdown cancels the timer, probes and webhooks before draining HTTP handlers.

## Platform behavior and limits

- Linux uses the installed `ping` executable, one IPv4 packet, a three-second
  reply timeout and five-second execution deadline. `LANG`/`LC_ALL=C` stabilize
  parsing. Missing binaries, permissions, malformed output and execution errors
  produce `status: error`, not a false down measurement. A system `ping` with
  unprivileged datagram support is required; see [deployment.md](deployment.md).
- Windows uses the OS `IcmpSendEcho` API instead of spawning/localizing `ping`.
  It uses standard user privileges and distinguishes timeout/unreachable replies
  from local API errors. Native calls finish within their three-second timeout;
  cancellation discards the result and shutdown waits for that bounded call.
  This avoids a detached cancellation goroutine per native request.
  See Microsoft's [API contract](https://learn.microsoft.com/en-us/windows/win32/api/icmpapi/nf-icmpapi-icmpsendecho).
- Linux and Windows amd64/arm64 builds are supported. Native tests run on Linux
  and Windows amd64; arm64 artifacts are cross-compiled, not locally executed.
  Other platforms are outside the support matrix.
- `x/text` supplies stroke collation but omits CLDR script reordering. A small
  adapter restores Han-before-Latin primary ordering (including mixed-name
  prefixes) and retains secondary/accent/case weights. The dependency and its
  key encoding are pinned and covered by Node/Go differential tests. Its older
  Unicode collation tables can still order newly added/rare characters differently
  from a newer Node ICU. This is an explicit compatibility limit, not a claim of
  identical ordering for every Unicode string. Custom category order is preserved.
- All API JSON fields and documented status codes remain compatible. HTTP server
  headers, static file validators, unknown-route HTML and log message formatting
  belong to their respective runtime and are not byte-identical. JSON input is
  uncompressed UTF-8 without a BOM, as sent by the dashboard. Express-specific
  gzip/deflate/Brotli request decompression and alternate charset decoding are
  not implemented; external clients using those encodings must send ordinary
  UTF-8 JSON. Go uses bounded HTTP headers/body read times; slow clients can be
  disconnected.
- `.env`, `data/` and `logs/` are relative to the working directory by default.
  `--dir` makes that choice explicit when installing a binary elsewhere. The old
  server anchored these paths to its source directory; launch from the existing
  installation directory to retain its data. Logs keep the same file paths,
  limits and retention but use Go's timestamp/message format.

## Verification

- `go test -race ./...`: config/env precedence, corrupt-file preservation,
  legacy normalization/reload, real concurrent CRUD/polling, bounded workers,
  cancellation/draining, rotation, platform probe behavior and real loopback ICMP.
- `npm test`: original Node/frontend/helper suites, retained as a baseline.
- `npm run test:go-contract`: existing backend/storage/probe/auth/webhook
  assertions run against the race-instrumented Go backend through a test-only
  loopback adapter. Tests that instantiate Node modules directly continue to
  test Node; corresponding Go units cover decoding/config/probe/cancellation.
  The dedicated differential test compares full API JSON, Unicode ordering,
  aliases, errors, counters and mutual storage readability.
- `TEST_BROWSER=1 npm run test:go-contract`: also executes the existing
  Playwright dashboard/demo suite against Go. Probe injection exists only in the
  Go test binary, never in the production executable.
- `scripts/build-release.py`: builds each binary twice and checks byte equality,
  then creates archives with fixed metadata and SHA-256 checksums.
- [benchmark.md](benchmark.md): reproducible measurements and qualifications.

CI runs Go race/vet on both OSes, Linux contract/browser tests, frontend checks,
and reproducible builds for all four targets. Publishing remains triggered by a
future version tag after those jobs pass. Tests and measured evidence do not
substitute for a hosted CI run; see the delivery summary for actual checks run.
