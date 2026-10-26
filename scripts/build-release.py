#!/usr/bin/env python3
"""Reproducible binaries and archives; requires exactly the pinned Go toolchain."""
import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

root = Path(__file__).resolve().parent.parent
p = argparse.ArgumentParser()
p.add_argument('--os', choices=['linux', 'windows'], required=True)
p.add_argument('--arch', choices=['amd64', 'arm64'], required=True)
p.add_argument('--output', type=Path, default=root / 'dist')
a = p.parse_args()
a.output.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, CGO_ENABLED='0', GOOS=a.os, GOARCH=a.arch, GOTOOLCHAIN='go1.27.3')
name = 'host-monitor' + ('.exe' if a.os == 'windows' else '')
with tempfile.TemporaryDirectory(prefix='host-monitor-build-') as tmp:
    staging = Path(tmp)
    binary = staging / name
    subprocess.run(['go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', str(binary), '.'], cwd=root, env=env, check=True)
    second = staging / 'second'
    subprocess.run(['go', 'build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=', '-o', str(second), '.'], cwd=root, env=env, check=True)
    if binary.read_bytes() != second.read_bytes():
        raise RuntimeError('binaries differ between consecutive builds')
    files = {name: binary.read_bytes()}
    for f in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md', 'README.md', 'README_TW.md', '.env.example', 'monitors.example.json', 'docs/migration.md', 'docs/migration-contract.md', 'docs/benchmark.md', 'docs/benchmark-results.json', 'docs/deployment.md', 'docs/validation.md', 'docs/images/demo-dashboard.png']:
        files[f] = (root / f).read_bytes()
    if a.os == 'linux':
        for f in ['start.sh', 'stop.sh', 'scripts/process-identity.sh']:
            files[f] = (root / f).read_bytes()
    stem = f'host-monitor-{a.os}-{a.arch}'
    if a.os == 'windows':
        artifact = a.output / (stem + '.zip')
        with zipfile.ZipFile(artifact, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for filename, data in sorted(files.items()):
                info = zipfile.ZipInfo(filename, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (0o755 if filename == name else 0o644) << 16
                archive.writestr(info, data)
    else:
        artifact = a.output / (stem + '.tar.gz')
        with artifact.open('wb') as out, gzip.GzipFile(filename='', mode='wb', fileobj=out, mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w') as archive:
            for filename, data in sorted(files.items()):
                info = tarfile.TarInfo(filename)
                info.size = len(data)
                info.mode = 0o755 if filename == name or filename.endswith('.sh') else 0o644
                info.mtime = 0
                archive.addfile(info, io.BytesIO(data))
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    (a.output / (artifact.name + '.sha256')).write_text(f'{digest}  {artifact.name}\n')
    print(digest, artifact)
