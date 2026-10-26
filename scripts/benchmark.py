#!/usr/bin/env python3
"""Linux /proc comparison of unchanged Node and production Go, on loopback only.
Run: python3 scripts/benchmark.py --go /tmp/host-monitor-go > docs/benchmark-results.json
Requires Node dependencies and system ping. Never reads/writes the user's data/.
"""
import argparse
import sys
import http.client
import hashlib
from datetime import datetime, timezone
import json
import os
import platform
import shutil
import socket
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TICKS = os.sysconf('SC_CLK_TCK')


def request(port, route='/api/health', method='GET'):
    c = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
    try:
        c.request(method, route)
        r = c.getresponse()
        return r.status, r.read()
    finally:
        c.close()


def metrics(pid):
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
    cpu = (int(fields[11]) + int(fields[12])) / TICKS
    # Include exited ping children, to avoid attributing process offloading as savings.
    children = (int(fields[13]) + int(fields[14])) / TICKS
    rss = int(Path(f'/proc/{pid}/status').read_text().split('VmRSS:')[1].split()[0])
    return cpu, children, rss


class Server:
    def __init__(self, implementation, binary, count, interval):
        self.tmp = tempfile.TemporaryDirectory(prefix='host-monitor-bench-')
        self.dir = Path(self.tmp.name)
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            self.port = s.getsockname()[1]
        (self.dir / 'data').mkdir()
        monitors = [{'ip': f'127.0.0.{i}', 'name': f'Host {i:03}', 'group': 'server'} for i in range(1, count + 1)]
        (self.dir / 'data/monitors.json').write_text(json.dumps({'monitors': monitors}))
        env = {k: v for k, v in os.environ.items() if k not in {
            'PORT', 'HOST', 'CHECK_INTERVAL', 'AUTH_ENABLED', 'WEBHOOK_ENABLED', 'PROBE_CONCURRENCY',
            'LOG_TO_STDOUT', 'MAX_MONITORS', 'MANUAL_CHECK_LIMIT'}}
        env.update(PORT=str(self.port), HOST='127.0.0.1', CHECK_INTERVAL=str(interval),
                   AUTH_ENABLED='false', WEBHOOK_ENABLED='false', PROBE_CONCURRENCY='5',
                   LOG_TO_STDOUT='false', MAX_MONITORS='100', MANUAL_CHECK_LIMIT='1000')
        if implementation == 'node':
            for f in ['server.js', 'app.js', 'config.js', 'auth.js', 'persisted-state.js', 'probes.js', 'scheduler.js', 'notifications.js']:
                shutil.copy2(ROOT / f, self.dir / f)
            (self.dir / 'public').symlink_to(ROOT / 'public', target_is_directory=True)
            (self.dir / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            cmd = ['node', 'server.js']
        else:
            cmd = [str(binary), '--dir', str(self.dir)]
        start = time.perf_counter()
        self.process = subprocess.Popen(cmd, cwd=self.dir, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = start + 15
        while True:
            if self.process.poll() is not None:
                self.close()
                raise RuntimeError(f'{implementation} failed startup')
            try:
                if request(self.port)[0] == 200:
                    break
            except OSError:
                pass
            if time.perf_counter() > deadline:
                self.close()
                raise TimeoutError('startup')
            time.sleep(.002)
        self.startup_ms = (time.perf_counter() - start) * 1000

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.tmp.cleanup()


def sample(impl, binary, mode, seconds):
    s = Server(impl, binary, 100 if mode == 'active' else 20, 1000 if mode == 'active' else 60000)
    try:
        time.sleep(2.2)  # Both implementations finish the initial loopback batch.
        before = metrics(s.process.pid)
        rss = []
        start = time.perf_counter()
        while time.perf_counter() - start < seconds:
            rss.append(metrics(s.process.pid)[2])
            time.sleep(.1)
        elapsed = time.perf_counter() - start
        after = metrics(s.process.pid)
        # Warm persistent HTTP connection; transfer complete JSON bodies.
        c = http.client.HTTPConnection('127.0.0.1', s.port, timeout=20)
        latencies = []
        for i in range(220):
            tick = time.perf_counter()
            c.request('GET', '/api/monitors')
            response = c.getresponse()
            body = response.read()
            if response.status != 200:
                raise RuntimeError('API latency request failed')
            if i >= 20:
                latencies.append((time.perf_counter() - tick) * 1000)
        c.close()
        state = json.loads(body)
        return dict(implementation=impl, mode=mode, startup_ms=s.startup_ms,
                    rss_kib_median=statistics.median(rss), rss_kib_peak=max(rss),
                    cpu_percent=(after[0]-before[0])/elapsed*100,
                    cpu_with_children_percent=(after[0]+after[1]-before[0]-before[1])/elapsed*100,
                    latency_p50_ms=statistics.median(latencies),
                    latency_p95_ms=sorted(latencies)[189],
                    total_checks=sum(m['totalChecks'] for m in state['monitors']),
                    errors=sum(m['status'] == 'error' for m in state['monitors']))
    finally:
        s.close()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--go', required=True, type=Path)
    p.add_argument('--seconds', type=float, default=5)
    p.add_argument('--repetitions', type=int, default=3)
    args = p.parse_args()
    binary = args.go.resolve()
    source = hashlib.sha256()
    for path in sorted([ROOT / 'main.go', ROOT / 'go.mod', ROOT / 'go.sum', *[p for p in (ROOT / 'internal').rglob('*.go') if not p.name.endswith('_test.go')], *[p for p in (ROOT / 'public').rglob('*') if p.is_file()]]):
        source.update(str(path.relative_to(ROOT)).encode() + b'\0' + path.read_bytes() + b'\0')
    result = dict(measured_at=datetime.now(timezone.utc).isoformat(), source_sha256=source.hexdigest(),
                  go_binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                  platform=platform.platform(), cpu=Path('/proc/cpuinfo').read_text().split('model name')[1].split('\n')[0].strip(' :\t'),
                  go=subprocess.check_output(['go', 'version'], text=True).strip(),
                  node=subprocess.check_output(['node', '--version'], text=True).strip(),
                  source_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                  go_binary_bytes=binary.stat().st_size,
                  node_executable_bytes=Path(shutil.which('node')).resolve().stat().st_size,
                  seconds=args.seconds, repetitions=args.repetitions, samples=[], startup_samples={})
    for impl in ['node', 'go']:
        result['startup_samples'][impl] = []
        for _ in range(10):
            s = Server(impl, binary, 20, 60000)
            result['startup_samples'][impl].append(s.startup_ms)
            s.close()
    for repetition in range(args.repetitions):
        for mode in ['idle', 'active']:
            # Alternate order to reduce systematic warm-cache effects.
            for impl in (['node', 'go'] if repetition % 2 == 0 else ['go', 'node']):
                row = sample(impl, binary, mode, args.seconds)
                result['samples'].append(row)
                print(json.dumps(row), file=sys.stderr, flush=True)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
