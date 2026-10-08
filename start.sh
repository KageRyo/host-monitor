#!/bin/bash
# Start Host Monitor as a detached Linux process.
cd -- "$(dirname -- "$0")" || exit 1
mkdir -p logs data || exit 1
source scripts/process-identity.sh
stop_recorded_process || exit 1
PORT_VALUE=$(node -e "const c = require('./config'); c.loadEnvFile(); console.log(c.readConfig().port)") || exit 1
setsid node server.js > logs/startup.log 2>&1 < /dev/null &
NEW_PID=$!
# Give exec/setsid time to establish the expected identity.
for ((attempt=0; attempt<20; attempt++)); do
  START_TIME=$(process_start_time "$NEW_PID") || START_TIME=''
  if is_expected_process "$NEW_PID" "$START_TIME"; then break; fi
  sleep 0.1
done
if ! is_expected_process "$NEW_PID" "$START_TIME"; then
  echo '❌ 啟動失敗，請查看 logs/startup.log 或 logs/monitor.log' >&2
  exit 1
fi
printf '%s\n' "$NEW_PID" > "$PID_FILE"
printf '%s\n' "$START_TIME" > "$IDENTITY_FILE"
sleep 2
if is_expected_process "$NEW_PID" "$START_TIME"; then
  echo "✅ 主機監測系統已啟動 (PID: $NEW_PID)"
  echo "   http://localhost:${PORT_VALUE}"
  echo '   區域網路網址請查看 logs/monitor.log'
else
  clear_identity
  echo '❌ 啟動失敗，請查看 logs/startup.log 或 logs/monitor.log' >&2
  exit 1
fi
