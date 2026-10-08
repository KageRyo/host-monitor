#!/bin/bash
# Linux process identity shared by the helper scripts. Never signal by name.
PROCESS_ROOT=$(pwd -P)
PID_FILE="$PROCESS_ROOT/logs/server.pid"
IDENTITY_FILE="$PROCESS_ROOT/logs/server.identity"

process_start_time() {
  local stat rest
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  rest=${stat##*) }
  # starttime is field 22; fields after comm start at 3.
  set -- $rest
  [ "$1" != Z ] || return 1
  printf '%s\n' "${20}"
}

is_expected_process() {
  local pid="$1" expected="$2" actual cwd exe
  [[ "$pid" =~ ^[1-9][0-9]*$ && "$expected" =~ ^[0-9]+$ ]] || return 1
  actual=$(process_start_time "$pid") || return 1
  [ "$actual" = "$expected" ] || return 1
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || return 1
  [ "$cwd" = "$PROCESS_ROOT" ] || return 1
  exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null) || return 1
  [ "${exe##*/}" = node ] || return 1
  local args=()
  mapfile -d '' -t args < "/proc/$pid/cmdline" 2>/dev/null || return 1
  [ "${#args[@]}" -eq 2 ] || return 1
  [[ "${args[1]}" = server.js || "${args[1]}" = "$PROCESS_ROOT/server.js" ]]
}

clear_identity() { rm -f -- "$PID_FILE" "$IDENTITY_FILE"; }

stop_recorded_process() {
  local pid expected
  if [ ! -f "$PID_FILE" ]; then
    echo '找不到 PID 檔案；未發送任何訊號。'
    rm -f -- "$IDENTITY_FILE"
    return 0
  fi
  pid=$(cat "$PID_FILE")
  expected=$(cat "$IDENTITY_FILE" 2>/dev/null) || expected=''
  if ! is_expected_process "$pid" "$expected"; then
    echo 'PID 已失效或程序身分不符；清理記錄，未發送任何訊號。'
    clear_identity
    return 0
  fi
  echo "正在停止主機監測系統 (PID: $pid)..."
  kill -TERM -- "$pid" 2>/dev/null || return 1
  for ((attempt=0; attempt<30; attempt++)); do
    if ! is_expected_process "$pid" "$expected"; then
      clear_identity
      echo '✅ 已停止'
      return 0
    fi
    sleep 0.1
  done
  # Recheck immediately before escalation; reused PIDs are never killed.
  if is_expected_process "$pid" "$expected"; then
    kill -KILL -- "$pid" 2>/dev/null || return 1
  fi
  for ((attempt=0; attempt<20; attempt++)); do
    if ! is_expected_process "$pid" "$expected"; then
      clear_identity
      echo '✅ 已停止'
      return 0
    fi
    sleep 0.1
  done
  echo '❌ 無法確認程序已停止；保留 PID 記錄。' >&2
  return 1
}
