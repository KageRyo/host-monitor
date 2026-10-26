package monitor

// This test-only process adapter runs the original JS integration tests against
// Go. Probe injection stays outside the production binary, via a loopback RPC.
import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"testing"
)

type bridgeLog struct{}

func (bridgeLog) Write(b []byte) (int, error) {
	v, _ := json.Marshal(map[string]string{"warning": strings.TrimSpace(string(b))})
	fmt.Println(string(v))
	return len(b), nil
}
func TestBridge(t *testing.T) {
	spec := os.Getenv("HM_TEST_BRIDGE")
	if spec == "" {
		t.Skip("subprocess integration adapter")
	}
	var cfg struct {
		Env                        map[string]string
		DataFile, ProbeURL, Public string
	}
	if e := json.Unmarshal([]byte(spec), &cfg); e != nil {
		t.Fatal(e)
	}
	log.SetOutput(bridgeLog{})
	c, e := ReadConfig(func(k string) (string, bool) { v, ok := cfg.Env[k]; return v, ok })
	if e != nil {
		t.Fatal(e)
	}
	probe := func(ctx context.Context, ip string) Result {
		req, _ := http.NewRequestWithContext(ctx, "POST", cfg.ProbeURL, strings.NewReader(ip))
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			return failedProbe()
		}
		defer res.Body.Close()
		var r struct {
			Alive *bool    `json:"alive"`
			RTT   *float64 `json:"rtt"`
			Error string   `json:"error"`
		}
		if json.NewDecoder(res.Body).Decode(&r) != nil {
			return failedProbe()
		}
		return Result{r.Alive, r.RTT, r.Error}
	}
	s, e := New(c, cfg.DataFile, os.DirFS(cfg.Public), probe)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	listener, e := net.Listen("tcp4", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/_bridge/start":
			s.Start()
			w.WriteHeader(204)
		case "/_bridge/stop":
			s.StopChecker()
			w.WriteHeader(204)
		default:
			s.ServeHTTP(w, r)
		}
	})
	srv := &http.Server{Handler: handler}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(listener) }()
	fmt.Printf("{\"base\":\"http://%s\"}\n", listener.Addr())
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	// EOF from parent closes this process on every platform, including Windows.
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	select {
	case <-ctx.Done():
		s.Close()
		_ = srv.Close()
	case e := <-done:
		if e != http.ErrServerClosed {
			t.Fatal(e)
		}
	}
}
