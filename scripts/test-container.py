#!/usr/bin/env python3
"""Exercise the production image with no capabilities and isolated volumes."""
import base64
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True).strip()


subprocess.run(['docker', 'build', '-t', 'host-monitor:go-migration', '.'], check=True)
volume = 'host-monitor-test-' + uuid.uuid4().hex
container = None
docker('volume', 'create', volume)
try:
    container = docker('run', '-d', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
                       '--sysctl=net.ipv4.ping_group_range=0 2147483647',
                       '-p', '127.0.0.1::3000', '-v', volume + ':/app/data',
                       '-e', 'AUTH_ENABLED=true', '-e', 'AUTH_USERNAME=test',
                       '-e', 'AUTH_PASSWORD=container-test', '-e', 'CHECK_INTERVAL=60000', '-e', 'LOG_TO_STDOUT=true',
                       'host-monitor:go-migration')
    port = docker('port', container, '3000/tcp').rsplit(':', 1)[1]
    base = 'http://127.0.0.1:' + port
    auth = 'Basic ' + base64.b64encode(b'test:container-test').decode()

    def request(route, method='GET', body=None):
        req = urllib.request.Request(base + route, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': auth, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)

    def ready():
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                if request('/api/health')['ok']:
                    return
            except OSError:
                pass
            time.sleep(.1)
        raise RuntimeError('container did not become healthy: ' + docker('inspect', container, '--format', '{{json .State}}') + docker('logs', container))

    ready()
    assert docker('exec', container, 'id', '-u') == '10001'
    try:
        urllib.request.urlopen(base + '/api/health', timeout=5)
        raise AssertionError('authentication bypassed')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    request('/api/monitors', 'POST', {'ip': '127.0.0.1', 'name': 'Container loopback'})
    result = request('/api/monitors/127-0-0-1/check', 'POST')
    assert result['status'] == 'up', result
    assert result['totalChecks'] >= 1
    docker('restart', '-t', '15', container)
    port = docker('port', container, '3000/tcp').rsplit(':', 1)[1]
    base = 'http://127.0.0.1:' + port
    ready()
    restored = request('/api/monitors')['monitors'][0]
    assert restored['name'] == 'Container loopback' and restored['totalChecks'] >= result['totalChecks']
    print('Container smoke passed: UID 10001, dropped capabilities, ICMP, auth, persisted restart.')
    print('Image bytes:', docker('image', 'inspect', 'host-monitor:go-migration', '--format', '{{.Size}}'))
finally:
    if container:
        docker('rm', '-f', '-v', container)
    docker('volume', 'rm', volume)
