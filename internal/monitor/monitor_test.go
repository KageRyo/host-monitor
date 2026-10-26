package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	c, e := ReadConfig(func(string) (string, bool) { return "", false })
	if e != nil {
		t.Fatal(e)
	}
	return c
}
func TestPersistedValidation(t *testing.T) {
	good := `{"ip":"192.0.2.1"}`
	cases := []string{`null`, `[]`, `{}`, `{"monitors":null}`, `{"monitors":{}}`, `{"monitors":[null]}`, `{"monitors":[` + good + `,` + good + `]}`, `{"monitors":[],"groupOrder":[null]}`, `{"monitors":[],"lastGlobalCheck":42}`}
	badFields := []string{`"ip":1`, `"ip":"bad"`, `"id":"wrong"`, `"name":null`, `"notes":{}`, `"group":[]`, `"history":null`, `"history":[null]`, `"history":[{"time":"bad","alive":true}]`, `"history":[{"time":"2026-01-01T00:00:00.000Z","alive":"false"}]`, `"totalChecks":-1`, `"totalChecks":1.5`, `"totalChecks":null`, `"totalChecks":1,"upChecks":2`, `"status":"bad"`, `"responseTime":-1`, `"lastCheck":"bad"`, `"status":"error"`, `"checkError":"secret"`, `"lastReachabilityStatus":"error"`, `"initialDownPending":null`, `"initialDownPending":"true"`, `"initialDownChecks":1`}
	for _, field := range badFields {
		cases = append(cases, `{"monitors":[{"ip":"192.0.2.1",`+field+`}]}`)
	}
	for i, raw := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "monitors.json")
			if e := os.WriteFile(file, []byte(raw), 0600); e != nil {
				t.Fatal(e)
			}
			if _, e := loadState(file); e == nil {
				t.Fatalf("accepted %s", raw)
			}
			after, _ := os.ReadFile(file)
			if string(after) != raw {
				t.Fatal("original changed")
			}
			copies, _ := filepath.Glob(file + ".corrupt-*")
			if len(copies) != 1 {
				t.Fatal("missing backup")
			}
			b, _ := os.ReadFile(copies[0])
			if string(b) != raw {
				t.Fatal("backup differs")
			}
		})
	}
}
func TestLegacyRoundTrip(t *testing.T) {
	raw := `{"monitors":[{"ip":"192.0.2.1","group":"NAS"},{"ip":"192.0.2.2","status":"up","history":[{"time":"2026-01-01T00:00:00.000Z","alive":true,"rtt":0}]}],"groupOrder":["NAS","nas","server"]}`
	s, e := decodeState([]byte(raw))
	if e != nil {
		t.Fatal(e)
	}
	if s.Monitors[1].TotalChecks != 1 || s.Monitors[1].UpChecks != 1 || s.Monitors[0].Group != "nas" {
		t.Fatal(s)
	}
	file := filepath.Join(t.TempDir(), "data", "monitors.json")
	if e = saveState(file, s); e != nil {
		t.Fatal(e)
	}
	reloaded, e := loadState(file)
	if e != nil {
		t.Fatal(e)
	}
	if len(reloaded.GroupOrder) != 2 || *reloaded.Monitors[1].History[0].RTT != 0 {
		t.Fatal("legacy data lost")
	}
}
func TestConfig(t *testing.T) {
	for _, bad := range []map[string]string{{"HOST": "localhost"}, {"AUTH_ENABLED": "wat"}, {"AUTH_ENABLED": "true"}, {"AUTH_ENABLED": "true", "AUTH_USERNAME": "a:b", "AUTH_PASSWORD": "pw"}} {
		if _, e := ReadConfig(func(k string) (string, bool) { v, ok := bad[k]; return v, ok }); e == nil {
			t.Fatal("accepted invalid config")
		}
	}
	env := map[string]string{"PORT": "0", "CHECK_INTERVAL": "1", "PROBE_CONCURRENCY": "-1", "WEBHOOK_ENABLED": "false"}
	c, e := ReadConfig(func(k string) (string, bool) { v, ok := env[k]; return v, ok })
	if e != nil || c.Port != 3000 || c.Interval != 30*time.Second || c.Concurrency != 5 || c.WebhookEnabled {
		t.Fatal(c, e)
	}
	dir := t.TempDir()
	file := filepath.Join(dir, ".env")
	t.Setenv("HM_PRECEDENCE", "env")
	_ = os.WriteFile(file, []byte("HM_PRECEDENCE=file\n# comment\nHM_QUOTED='with spaces'\n"), 0600)
	t.Setenv("HM_QUOTED_SENTINEL", "")
	defer os.Unsetenv("HM_QUOTED")
	if e := LoadEnv(file); e != nil {
		t.Fatal(e)
	}
	if os.Getenv("HM_PRECEDENCE") != "env" || os.Getenv("HM_QUOTED") != "with spaces" {
		t.Fatal("dotenv precedence/quotes")
	}
}
func TestCancellationAndConcurrency(t *testing.T) {
	c := testConfig(t)
	c.Concurrency = 2
	var active, peak atomic.Int32
	gate := make(chan struct{}, 2)
	probe := func(ctx context.Context, _ string) Result {
		n := active.Add(1)
		defer active.Add(-1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		gate <- struct{}{}
		<-ctx.Done()
		return failedProbe()
	}
	s, e := New(c, filepath.Join(t.TempDir(), "data.json"), nil, probe)
	if e != nil {
		t.Fatal(e)
	}
	s.mu.Lock()
	for i := 1; i <= 10; i++ {
		s.state.Monitors = append(s.state.Monitors, newMonitor(fmt.Sprintf("192.0.2.%d", i)))
	}
	jobs, ok := s.beginBatchLocked()
	s.mu.Unlock()
	if !ok {
		t.Fatal("batch did not start")
	}
	// Only active probes enter this gate. Cancel with queued work still pending.
	<-gate
	<-gate
	// A cancelled queued job must not invoke a probe that ignores cancellation.
	s.Close()
	if peak.Load() != 2 || active.Load() != 0 {
		t.Fatal("worker bounds or shutdown violated")
	}
	for _, j := range jobs {
		select {
		case <-j.done:
		default:
			t.Fatal("job leaked")
		}
	}
}
func TestConcurrentCRUDAndPolling(t *testing.T) {
	c := testConfig(t)
	c.ManualLimit = 1000
	alive := true
	s, e := New(c, filepath.Join(t.TempDir(), "state.json"), nil, func(context.Context, string) Result { return Result{Alive: &alive} })
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	var wg sync.WaitGroup
	for i := 1; i <= 8; i++ {
		i := i
		wg.Add(1)
		go func() {
			defer wg.Done()
			ip := fmt.Sprintf("192.0.2.%d", i)
			id := strings.ReplaceAll(ip, ".", "-")
			for _, req := range [][3]string{{"POST", "/api/monitors", `{"ip":"` + ip + `"}`}, {"POST", "/api/monitors/" + id + "/check", ""}, {"GET", "/api/monitors", ""}, {"PUT", "/api/monitors/" + id, `{"notes":"changed"}`}, {"DELETE", "/api/monitors/" + id, ""}} {
				r := httptest.NewRequest(req[0], req[1], strings.NewReader(req[2]))
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				s.ServeHTTP(w, r)
				if w.Code >= 400 {
					t.Errorf("%s %s: %d %s", req[0], req[1], w.Code, w.Body.String())
				}
			}
		}()
	}
	wg.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.state.Monitors) != 0 {
		t.Fatal("CRUD lost updates")
	}
}
func TestLogRotation(t *testing.T) {
	c := testConfig(t)
	c.LogMaxBytes = 8
	c.LogMaxFiles = 2
	c.LogStdout = false
	file := filepath.Join(t.TempDir(), "logs", "monitor.log")
	w := NewLog(c, file)
	for _, s := range []string{"first\n", "second\n", "third\n", "fourth\n"} {
		if _, e := w.Write([]byte(s)); e != nil {
			t.Fatal(e)
		}
	}
	for suffix, want := range map[string]string{"": "fourth\n", ".1": "third\n", ".2": "second\n"} {
		b, e := os.ReadFile(file + suffix)
		if e != nil || string(b) != want {
			t.Fatal(suffix, string(b), e)
		}
	}
}
func TestHealthJSON(t *testing.T) {
	s, e := New(testConfig(t), filepath.Join(t.TempDir(), "state.json"), nil, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))
	var body map[string]any
	if json.Unmarshal(w.Body.Bytes(), &body) != nil || body["ok"] != true || body["lastCheck"] != nil {
		t.Fatal(w.Body.String())
	}
}

func TestSystemProbeLoopback(t *testing.T) {
	r := SystemProbe(context.Background(), "127.0.0.1")
	if r.Alive == nil || !*r.Alive || r.RTT == nil {
		t.Fatalf("loopback ping requires working platform ICMP support: %+v", r)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if r := SystemProbe(ctx, "127.0.0.1"); r.Error != probeError {
		t.Fatal("cancelled probe was accepted")
	}
}
