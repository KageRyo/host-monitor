package monitor

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func respond(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func apiError(w http.ResponseWriter, code int, message string) {
	respond(w, code, map[string]string{"error": message})
}
func (s *Service) authorize(w http.ResponseWriter, r *http.Request) bool {
	if !s.config.AuthEnabled {
		return true
	}
	w.Header().Set("Cache-Control", "no-store")
	scheme, encoded, _ := strings.Cut(r.Header.Get("Authorization"), " ")
	decoded, e := base64.StdEncoding.DecodeString(encoded)
	expected := sha256.Sum256([]byte(s.config.Username + ":" + s.config.Password))
	actual := sha256.Sum256(decoded)
	if !strings.EqualFold(scheme, "Basic") || e != nil || encoded == "" || subtle.ConstantTimeCompare(expected[:], actual[:]) != 1 {
		w.Header().Set("WWW-Authenticate", `Basic realm="Host Monitor", charset="UTF-8"`)
		apiError(w, 401, "Authentication required")
		return false
	}
	if !contains(r.Method, "GET", "HEAD", "OPTIONS") {
		foreign := false
		if origin := r.Header.Get("Origin"); origin != "" {
			u, e := url.Parse(origin)
			foreign = e != nil || u.Host != r.Host
		}
		if foreign || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			apiError(w, 403, "Cross-site operation rejected")
			return false
		}
	}
	return true
}
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r) {
		return
	}
	var body map[string]any
	if strings.EqualFold(trimJS(strings.Split(r.Header.Get("Content-Type"), ";")[0]), "application/json") {
		raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 102400))
		if e != nil {
			apiError(w, 413, "JSON body too large")
			return
		}
		if len(raw) > 0 {
			trim := bytes.TrimSpace(raw)
			if len(trim) == 0 || (trim[0] != '{' && trim[0] != '[') || json.Unmarshal(raw, &body) != nil {
				// Arrays are syntactically valid JSON but fail the route's object requirement.
				var array []any
				if len(trim) > 0 && trim[0] == '[' && json.Unmarshal(raw, &array) == nil {
					body = nil
				} else {
					apiError(w, 400, "Invalid JSON")
					return
				}
			}
		}
	}
	path := strings.TrimSuffix(r.URL.Path, "/")
	method := r.Method
	if method == "HEAD" {
		method = "GET"
	}
	objectRoute := (path == "/api/monitors" && method == "POST") || (method == "PUT" && (path == "/api/groups/order" || strings.HasPrefix(path, "/api/monitors/")))
	if objectRoute {
		if body == nil {
			apiError(w, 400, "Expected a JSON object")
			return
		}
		for _, f := range []string{"name", "group", "notes"} {
			if v, ok := body[f]; ok {
				if _, ok := v.(string); !ok {
					apiError(w, 400, f+" must be a string")
					return
				}
			}
		}
	}
	if !strings.HasPrefix(path, "/api/") {
		if method == "GET" && s.assets != nil {
			http.FileServer(http.FS(s.assets)).ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		apiError(w, 503, "Service shutting down")
		return
	}
	text := func(k string) string { v, _ := body[k].(string); return v }
	switch {
	case path == "/api/health" && method == "GET":
		respond(w, 200, map[string]any{"ok": true, "monitors": len(s.state.Monitors), "lastCheck": s.state.LastGlobalCheck})
	case path == "/api/monitors" && method == "GET":
		respond(w, 200, map[string]any{"monitors": s.sortedLocked(), "stats": s.statsLocked(), "isChecking": s.checking})
	case path == "/api/monitors" && method == "POST":
		ip := text("ip")
		if ip == "" {
			apiError(w, 400, "IP is required")
			return
		}
		ip = trimJS(ip)
		if !validIP(ip) {
			apiError(w, 400, "Invalid IP format")
			return
		}
		m := newMonitor(ip)
		if s.findLocked(m.ID) != nil {
			apiError(w, 409, "Monitor with this IP already exists")
			return
		}
		if len(s.state.Monitors) >= s.config.MaxMonitors {
			apiError(w, 409, "已達主機數量上限，請刪除項目或調整 MAX_MONITORS")
			return
		}
		if name := trimJS(text("name")); name != "" {
			m.Name = name
		}
		m.Group = groupKey(text("group"))
		m.Notes = trimJS(text("notes"))
		s.state.Monitors = append(s.state.Monitors, m)
		if s.saveLocked() != nil {
			s.state.Monitors = s.state.Monitors[:len(s.state.Monitors)-1]
			apiError(w, 500, writeError)
			return
		}
		respond(w, 201, m)
	case path == "/api/groups/order" && method == "GET":
		respond(w, 200, map[string]any{"order": s.state.GroupOrder})
	case path == "/api/groups/order" && method == "PUT":
		values, ok := body["order"].([]any)
		if !ok {
			apiError(w, 400, "order 必須是陣列")
			return
		}
		order := []string{}
		seen := map[string]bool{}
		existing := map[string]bool{}
		for _, m := range s.state.Monitors {
			existing[m.Group] = true
		}
		for _, v := range values {
			g, ok := v.(string)
			if !ok {
				apiError(w, 400, "order 必須是陣列")
				return
			}
			g = groupKey(g)
			if existing[g] && !seen[g] {
				order = append(order, g)
				seen[g] = true
			}
		}
		for _, m := range s.state.Monitors {
			if !seen[m.Group] {
				order = append(order, m.Group)
				seen[m.Group] = true
			}
		}
		old := s.state.GroupOrder
		s.state.GroupOrder = order
		if s.saveLocked() != nil {
			s.state.GroupOrder = old
			apiError(w, 500, writeError)
			return
		}
		respond(w, 200, map[string]any{"success": true, "order": order})
	case path == "/api/check-all" && method == "POST":
		if !s.acquireLocked(w) {
			return
		}
		jobs, ok := s.beginBatchLocked()
		if !ok {
			apiError(w, 429, "Check already in progress")
			return
		}
		s.mu.Unlock()
		saved := s.finishBatch(jobs)
		s.mu.Lock()
		if !saved {
			apiError(w, 500, writeError)
			return
		}
		respond(w, 200, map[string]any{"success": true, "stats": s.statsLocked(), "monitors": s.sortedLocked()})
	case strings.HasPrefix(path, "/api/monitors/"):
		id := strings.TrimPrefix(path, "/api/monitors/")
		checking := strings.HasSuffix(id, "/check") && method == "POST"
		if checking {
			id = strings.TrimSuffix(id, "/check")
			if !s.acquireLocked(w) {
				return
			}
		}
		m := s.findLocked(id)
		if m == nil {
			apiError(w, 404, "Not found")
			return
		}
		switch {
		case checking:
			if s.jobs[m] != nil {
				apiError(w, 429, "Check already in progress")
				return
			}
			j := s.enqueueLocked(m)
			s.mu.Unlock()
			<-j.done
			s.mu.Lock()
			if !j.saved {
				apiError(w, 500, writeError)
				return
			}
			respond(w, 200, listedMonitor{m, groupLabel(m.Group)})
		case method == "PUT":
			old := *m
			if name := text("name"); name != "" {
				m.Name = trimJS(name)
			}
			if g := trimJS(text("group")); g != "" {
				m.Group = groupKey(g)
			}
			if _, ok := body["notes"]; ok {
				m.Notes = trimJS(text("notes"))
			}
			if s.saveLocked() != nil {
				*m = old
				apiError(w, 500, writeError)
				return
			}
			respond(w, 200, m)
		case method == "DELETE":
			old := append([]*Monitor{}, s.state.Monitors...)
			for i, v := range s.state.Monitors {
				if v == m {
					s.state.Monitors = append(s.state.Monitors[:i], s.state.Monitors[i+1:]...)
					break
				}
			}
			if s.saveLocked() != nil {
				s.state.Monitors = old
				apiError(w, 500, writeError)
				return
			}
			respond(w, 200, map[string]bool{"success": true})
		default:
			http.NotFound(w, r)
		}
	default:
		http.NotFound(w, r)
	}
}
func (s *Service) acquireLocked(w http.ResponseWriter) bool {
	now := time.Now()
	if s.quotaStart.IsZero() || !now.Before(s.quotaStart.Add(time.Minute)) {
		s.quotaStart = now
		s.quotaCount = 0
	}
	if s.quotaCount >= s.config.ManualLimit {
		retry := int(time.Until(s.quotaStart.Add(time.Minute)).Seconds() + 0.999)
		if retry < 1 {
			retry = 1
		}
		w.Header().Set("Retry-After", strconv.Itoa(retry))
		apiError(w, 429, "檢查請求過於頻繁，請稍後再試")
		return false
	}
	s.quotaCount++
	return true
}
