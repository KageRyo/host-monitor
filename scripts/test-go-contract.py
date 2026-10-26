#!/usr/bin/env python3
"""Run original integration assertions against a race-instrumented Go server."""
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
with tempfile.TemporaryDirectory(prefix='host-monitor-contract-') as tmp:
    binary = Path(tmp) / ('contract.exe' if os.name == 'nt' else 'contract')
    subprocess.run(['go', 'test', '-c', '-race', '-o', str(binary), './internal/monitor'], cwd=root, check=True)
    env = dict(os.environ, GO_BACKEND=str(binary))
    subprocess.run(['node', '--test', 'tests/backend.test.js', 'tests/storage.test.js',
                    'tests/probe.test.js', 'tests/webhook.test.js', 'tests/auth.test.js',
                    'tests/compatibility.test.cjs'], cwd=root, env=env, check=True)
    if os.environ.get('TEST_BROWSER') == '1':
        subprocess.run(['npm', 'run', 'test:browser'], cwd=root, env=env, check=True)
