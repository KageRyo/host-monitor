# Node → Go compatibility contract

Recorded from `app.js`, `config.js`, `persisted-state.js`, `probes.js`,
`scheduler.js`, `notifications.js`, `server.js`, and `public/shared.js` before
implementing Go. The original Node entrypoint and tests remain available.

- All dashboard assets and API endpoints use the same optional Basic auth;
  authenticated cross-site writes are rejected. JSON bodies are limited to 100 KiB.
- Routes: GET /api/health, GET/POST /api/monitors, PUT/DELETE
  /api/monitors/:id, POST /api/monitors/:id/check, POST /api/check-all,
  GET/PUT /api/groups/order. Preserve status codes and JSON keys/messages.
- IPv4 only; IDs replace dots with hyphens. Names, groups and notes trim on
  creation. Group aliases map to server/nas/printer/edge; arbitrary groups,
  including JavaScript prototype names, remain valid. server sorts first by
  default, other groups/names use Traditional Chinese collation. Explicit group
  order takes precedence; newly seen groups follow it.
- API output includes counters, nullable timestamps/RTT/errors, initial-down
  progress and (for list/check output) groupLabel. avgUptime averages each
  measured monitor's lifetime fraction, rounded to one decimal; never measured
  monitors are excluded. No measurements means null.
- Each probe retains the latest 60 history entries. Reachability increments
  lifetime counters; execution errors append a null outcome and do not increment
  counters. The last confirmed reachability survives execution errors.
- One bounded FIFO scheduler serves automatic and manual checks. Duplicate work
  coalesces for automatic checks; repeated manual checks return 429. A shared
  fixed 60-second manual quota includes missing IDs and busy requests.
- A startup check is scheduled at 1500 ms alongside an independent interval at
  CHECK_INTERVAL from startup (an interval below 1500 ms can fire first).
  Overlapping batches are skipped. Empty batches still update the global
  check timestamp. Deleting/recreating an IP cannot adopt an earlier probe.
- data/monitors.json contains monitors, groupOrder, lastGlobalCheck and savedAt.
  Legacy missing fields normalize; invalid files stop startup and are copied to
  a uniquely named .corrupt-* file. All state is validated before adoption.
  Writes use a same-directory temporary file and replacement; failed writes
  roll back memory and suppress webhook delivery.
- Webhook payloads report only persisted confirmed status transitions, with an
  optional consecutive initial-down threshold. Tool errors reset that threshold.
  Two delivery workers, 100 waiting events, timeout, no retries, no URL/body/error
  secrets in logs. Closing cancels deliveries and discards waiting events.
- Existing .env syntax and process-env precedence, defaults/ranges, opt-in auth,
  webhook and rotating logs remain supported. Default bind 0.0.0.0:3000, interval
  30000 ms, concurrency 5, monitor cap 100, manual quota 10/minute.
- Production assets are the existing public directory; theme, filters, history,
  categories and polling are browser code and remain unchanged.

Platform implementation and measured deviations are recorded in migration.md.
