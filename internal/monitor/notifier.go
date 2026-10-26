package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"sync"
)

type notifier struct {
	ctx    context.Context
	queue  chan []byte
	wg     sync.WaitGroup
	client *http.Client
	target string
}

func newNotifier(ctx context.Context, c Config) *notifier {
	if !c.WebhookEnabled {
		return nil
	}
	u, e := url.Parse(c.WebhookURL)
	if e != nil || u.Host == "" || !contains(u.Scheme, "http", "https") {
		log.Print("Webhook URL invalid; notifications disabled")
		return nil
	}
	n := &notifier{ctx: ctx, queue: make(chan []byte, 100), target: c.WebhookURL, client: &http.Client{Timeout: c.WebhookTimeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	for i := 0; i < 2; i++ {
		n.wg.Add(1)
		go n.run()
	}
	return n
}
func (n *notifier) notify(v any) {
	if n == nil || n.ctx.Err() != nil {
		return
	}
	b, e := json.Marshal(v)
	if e != nil {
		return
	}
	select {
	case n.queue <- b:
	default:
		log.Print("Webhook queue full; event dropped")
	}
}
func (n *notifier) run() {
	defer n.wg.Done()
	for {
		select {
		case <-n.ctx.Done():
			return
		case b := <-n.queue:
			if n.ctx.Err() != nil {
				return
			}
			req, e := http.NewRequestWithContext(n.ctx, "POST", n.target, bytes.NewReader(b))
			if e != nil {
				continue
			}
			req.Header.Set("Content-Type", "application/json")
			// Preserve URL userinfo behavior from the original transport without logging it.
			if req.URL.User != nil {
				p, _ := req.URL.User.Password()
				req.SetBasicAuth(req.URL.User.Username(), p)
			}
			res, e := n.client.Do(req)
			if e != nil {
				if n.ctx.Err() == nil {
					log.Print("Webhook request failed")
				}
				continue
			}
			_, e = io.Copy(io.Discard, res.Body)
			res.Body.Close()
			if n.ctx.Err() == nil {
				if e != nil {
					log.Print("Webhook response failed")
				} else if res.StatusCode < 200 || res.StatusCode >= 300 {
					log.Printf("Webhook HTTP %d", res.StatusCode)
				}
			}
		}
	}
}
func (n *notifier) wait() {
	if n != nil {
		n.wg.Wait()
		n.client.CloseIdleConnections()
	}
}
