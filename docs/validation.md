# Local migration validation — 2026-10-26

Scope: the local Go migration in this working tree, against the unchanged Node
backend at baseline commit `9cefa42e1f130bba1392c7bb06a63eba6f3a392d`.
This is a local delivery; no push, PR, merge, tag, release, hosted CI run or service
replacement was performed.

| Gate | Observed evidence |
| --- | --- |
| Go integrity/static/race | `go mod verify`, `go vet ./...`, `go test -race ./...` passed on Linux amd64 with Go 1.27.3. |
| Original suites | `npm test`: 63 passed, 0 failed, 1 skipped (the Go-only differential test). Linux helper tests now start/stop the Go production binary and preserve unrelated processes. |
| Contract adapter | Race-instrumented `go test -c` adapter plus existing JS backend/storage/probe/auth/webhook/differential suites: 40 passed, 0 failed. Some original tests instantiate Node modules directly; Go units cover their corresponding implementations, as described in migration.md. |
| Full browser flow | Existing `npm run test:browser` with `GO_BACKEND` pointing to the Go test binary passed. Includes actual Go routes and JSON persistence, authenticated CRUD, category ordering, manual checks, unknown uptime and error UI; the static demo also passes. Chromium's missing local shared libraries were extracted to a temporary directory and supplied with `LD_LIBRARY_PATH`; host packages were not changed. |
| Windows native execution | Cross-compiled Windows amd64 Go test executable was actually run through WSL Windows interop and passed, including file replacement, concurrent CRUD, shutdown, webhook bounds and native ICMP loopback. The Windows token was separately verified as non-administrator. This local Windows run used CGO=0, not race instrumentation. Windows race is configured in CI and has not run remotely. |
| Production container | Docker Desktop build and smoke test passed with UID 10001, all capabilities dropped, no-new-privileges, datagram ICMP, authenticated API and persisted state after restart. Temporary container/volumes were removed. The final license-only layer was checked for both license files. |
| Workflow syntax | `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12` passed. |
| Cross-platform packaging | Linux/Windows amd64/arm64 binaries built with Go 1.27.3. Each binary is built twice and compared. Separate complete packaging runs also produce identical archives/checksums. ARM64 was cross-compiled, not executed locally. |
| Frontend/license preservation | `git diff -- public/ LICENSE` is empty. Go dependency/runtime notices are included in the image and release archives. |
| Performance | Final production executable SHA-256 matches benchmark-results.json. Three equivalent idle/active workloads per implementation and ten startup samples each are documented in benchmark.md. |

Artifacts are generated under ignored `dist/`, with adjacent `.sha256` files.
The reproducible build script selects the pinned toolchain and does not require
Node. Release contents include config examples, licensing and the methodology/raw
benchmark report. Known collation/runtime differences and measurement limits are
explicit in migration.md and benchmark.md. Existing application data and shared
services were not modified.
