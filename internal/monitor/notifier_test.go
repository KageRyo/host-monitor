package monitor

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestWebhookBoundAndClose(t *testing.T) {
	started := make(chan struct{}, 4)
	var count atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		count.Add(1)
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c := testConfig(t)
	c.WebhookEnabled = true
	c.WebhookURL = server.URL
	c.WebhookTimeout = time.Second
	n := newNotifier(ctx, c)
	defer n.wait()
	defer cancel()
	n.notify(map[string]string{"event": "one"})
	n.notify(map[string]string{"event": "two"})
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(2 * time.Second):
			t.Fatal("webhook workers did not start")
		}
	}
	for i := 0; i < 101; i++ {
		n.notify(map[string]int{"queued": i})
	}
	if len(n.queue) != 100 || count.Load() != 2 {
		t.Fatal("webhook bounds violated", len(n.queue), count.Load())
	}
	cancel()
	n.wait()
	n.notify(map[string]string{"event": "closed"})
	if count.Load() != 2 {
		t.Fatal("queued webhook delivered after close")
	}
}
func TestGoManualWindow(t *testing.T) {
	s := &Service{config: Config{ManualLimit: 1}}
	if !s.acquireLocked(httptest.NewRecorder()) {
		t.Fatal("first acquisition rejected")
	}
	w := httptest.NewRecorder()
	if s.acquireLocked(w) || w.Code != 429 || w.Header().Get("Retry-After") == "" {
		t.Fatal("quota did not reject with retry")
	}
	s.quotaStart = time.Now().Add(-time.Minute)
	if !s.acquireLocked(httptest.NewRecorder()) {
		t.Fatal("quota failed to reset")
	}
}
