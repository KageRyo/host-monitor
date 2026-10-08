#!/bin/bash
# Stop only the exact process recorded by start.sh.
cd -- "$(dirname -- "$0")" || exit 1
source scripts/process-identity.sh
stop_recorded_process
