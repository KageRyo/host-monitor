# Node → Go benchmark

Measured 2026-10-26T01:52:51.244105+00:00 on Linux-6.18.33.2-microsoft-standard-WSL2-x86_64-with-glibc2.43, 12th Gen Intel(R) Core(TM) i7-12700KF.
Node v22.23.4; go version go1.27.3 linux/amd64. These are local WSL2 results, not a general
performance guarantee. Raw measurements and input hashes are in
[benchmark-results.json](benchmark-results.json).

## Reproduce

```sh
npm ci --include=dev --ignore-scripts
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags='-s -w -buildid=' -o /tmp/host-monitor-go .
python3 scripts/benchmark.py --go /tmp/host-monitor-go > docs/benchmark-results.json
```

Requires Linux `/proc`, Python 3, Node 22 and system ping. The runner copies the
unchanged Node sources into temporary directories, uses the same dependencies as
the original app, and starts the real `server.js`. Go runs its production binary.
Both use isolated JSON files, the same loopback targets, probe concurrency 5,
auth/webhooks disabled, file logging enabled, stdout logging disabled and normal
persistence after every result. Existing configuration/data are never read.

- Idle: 20 hosts, 60000 ms interval, sampled after the initial batch completes.
- Active: 100 distinct loopback IPv4 hosts, 1000 ms interval; all probes are real
  system ping processes in both implementations. All final host states are up,
  with zero probe execution errors. Each active sample completed 800 checks
  including startup/warmup, versus 20 for idle.
- Each mode has 3 independent process runs per implementation, alternating order.
  After 2.2 seconds of warmup, sample RSS every 100 ms for 5 seconds and measure
  CPU ticks across that window. CPU is percent of one core; 100% is one fully
  occupied core, not the whole machine. Child CPU includes exited/reaped ping
  processes, avoiding misleading savings from offloading work. RSS is for the
  service process and excludes transient ping children.
- After sampling, warm one persistent HTTP connection with 20 GET requests,
  then time 200 sequential full `/api/monitors` responses. Report the median of
  each run's p50/p95. Network serialization and body reads are included;
  client connection establishment is excluded from latency.
- Startup: 10 separate processes with 20 stored hosts, measured from spawn to
  first successful health response, polling every 2 ms. Includes runtime/imports,
  state loading and listener setup; excludes compilation. Caches are warm.

## Results

Values below are medians across the three mode runs, not precision estimates.

| Mode | Measurement | Node | Go | Unit |
| --- | --- | ---: | ---: | --- |
| idle | Service RSS | 67.434 | 12.766 | MiB |
| idle | Service CPU | 0.000 | 0.000 | % of one core |
| idle | CPU including reaped ping children | 0.000 | 0.000 | % of one core |
| idle | GET /api/monitors p50 | 0.447 | 0.213 | ms |
| idle | GET /api/monitors p95 | 0.710 | 0.282 | ms |
| active | Service RSS | 83.492 | 14.371 | MiB |
| active | Service CPU | 11.768 | 11.766 | % of one core |
| active | CPU including reaped ping children | 20.344 | 16.553 | % of one core |
| active | GET /api/monitors p50 | 0.772 | 0.446 | ms |
| active | GET /api/monitors p95 | 0.979 | 0.903 | ms |

Startup median: **75.92 ms Node → 5.13 ms Go**.
Executable size: **119.12 MiB Node → 8.97 MiB Go**.
The Node value is its executable only, excluding JS sources, node_modules,
frontend files and any shared system libraries; the Go value includes the
frontend and collation tables. This is an executable comparison, not a total
installation or container comparison. The tested Go Alpine image is 28193947
bytes (uncompressed Docker image size); no Node image size claim is made.

For these workloads, median service RSS fell about 81% idle and 83% active;
startup was about 15 times faster. Active CPU in the service process was
essentially equal. Counting ping children, CPU fell about 19%. Idle CPU in both
implementations rounded to zero at the sample resolution, so there is no evidence
of an idle CPU improvement. API latency improved in this sample, but it is
sub-millisecond loopback traffic and should not be extrapolated to WAN use.

## Trade-offs and limits

Go now syncs temporary data before replacement, while Node only writes/renames.
That intentional durability improvement can cost more on slow or networked
filesystems. Both still rewrite JSON after every monitor result for compatibility;
this remains a scaling limit. Go's pinned collation dependency contributes to the
binary size and sorting allocations; request-local keys avoid repeated work in a
single inventory response. Windows uses native ICMP and has different process
costs, so Linux measurements do not establish Windows performance improvements.

Three short local runs do not establish statistical significance. Scheduler load,
filesystem caches, Go/Node garbage collection and WSL2 virtualization can move
results. Observed RSS peaks are sampled, not exhaustive maximums. Child CPU can
under-count an in-flight ping at a sampling boundary; tiny negative near-zero
values in the raw file are floating-point subtraction noise. The test does not
measure large history files, unreachable networks, hundreds of slow probes,
long-running heap behavior, or production disk durability under power failure.
No performance claim is made for those unmeasured conditions.

The source commit in the raw report identifies the unchanged Node baseline;
the runtime source hash identifies the uncommitted Go implementation plus assets
and module lockfiles used in the measurement. The binary SHA-256 is recorded too.
