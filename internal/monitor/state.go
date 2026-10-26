package monitor

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const probeError = "probe_execution_failed"
const writeError = "資料儲存失敗，請確認磁碟空間與 data/ 目錄權限後再試一次"

type Entry struct {
	Time  string   `json:"time"`
	Alive *bool    `json:"alive"`
	RTT   *float64 `json:"rtt"`
	Error string   `json:"error,omitempty"`
}
type Monitor struct {
	ID                     string   `json:"id"`
	IP                     string   `json:"ip"`
	Name                   string   `json:"name"`
	Group                  string   `json:"group"`
	Notes                  string   `json:"notes"`
	Status                 string   `json:"status"`
	CheckError             *string  `json:"checkError"`
	LastReachabilityStatus string   `json:"lastReachabilityStatus"`
	InitialDownPending     bool     `json:"initialDownPending"`
	InitialDownChecks      int64    `json:"initialDownChecks"`
	ResponseTime           *float64 `json:"responseTime"`
	LastCheck              *string  `json:"lastCheck"`
	History                []Entry  `json:"history"`
	TotalChecks            int64    `json:"totalChecks"`
	UpChecks               int64    `json:"upChecks"`
}
type State struct {
	Monitors        []*Monitor `json:"monitors"`
	GroupOrder      []string   `json:"groupOrder"`
	LastGlobalCheck *string    `json:"lastGlobalCheck"`
	SavedAt         *string    `json:"savedAt,omitempty"`
}

func stamp() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func groupKey(s string) string {
	s = trimJS(s)
	switch s {
	case "", "伺服器":
		return "server"
	case "NAS":
		return "nas"
	case "印表機":
		return "printer"
	case "邊緣裝置", "邊緣版":
		return "edge"
	}
	return s
}
func groupLabel(s string) string {
	switch s {
	case "server":
		return "伺服器"
	case "nas":
		return "NAS"
	case "printer":
		return "印表機"
	case "edge":
		return "邊緣裝置"
	}
	return s
}
func newMonitor(ip string) *Monitor {
	return &Monitor{ID: strings.ReplaceAll(ip, ".", "-"), IP: ip, Name: ip, Group: "server", Status: "unknown", LastReachabilityStatus: "unknown", InitialDownPending: true, History: []Entry{}}
}
func timestamp(s *string) bool {
	if s == nil {
		return true
	}
	_, e := time.Parse(time.RFC3339Nano, *s)
	return e == nil && len(*s) > 10 && (*s)[10] == 'T'
}
func validRTT(f *float64) bool { return f == nil || (!math.IsNaN(*f) && !math.IsInf(*f, 0) && *f >= 0) }
func counter(n int64) bool     { return n >= 0 && n <= 9007199254740991 }
func contains(s string, values ...string) bool {
	for _, v := range values {
		if v == s {
			return true
		}
	}
	return false
}

func decodeState(raw []byte) (State, error) {
	bad := func() (State, error) { return State{}, errors.New("invalid persisted state") }
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return bad()
	}
	var records []json.RawMessage
	if json.Unmarshal(fields["monitors"], &records) != nil || records == nil {
		return bad()
	}
	s := State{Monitors: []*Monitor{}, GroupOrder: []string{}}
	if b, ok := fields["groupOrder"]; ok {
		if json.Unmarshal(b, &s.GroupOrder) != nil || s.GroupOrder == nil {
			return bad()
		}
		var items []json.RawMessage
		_ = json.Unmarshal(b, &items)
		for _, v := range items {
			if string(v) == "null" {
				return bad()
			}
		}
	}
	if b, ok := fields["lastGlobalCheck"]; ok {
		if json.Unmarshal(b, &s.LastGlobalCheck) != nil || !timestamp(s.LastGlobalCheck) {
			return bad()
		}
	}
	if b, ok := fields["savedAt"]; ok {
		if json.Unmarshal(b, &s.SavedAt) != nil || !timestamp(s.SavedAt) {
			return bad()
		}
	}
	seen := map[string]bool{}
	for _, r := range records {
		var f map[string]json.RawMessage
		if json.Unmarshal(r, &f) != nil || f == nil {
			return bad()
		}
		// Null is valid only for explicitly nullable fields.
		for _, k := range []string{"ip", "id", "name", "group", "notes", "history", "totalChecks", "upChecks", "status", "lastReachabilityStatus", "initialDownPending", "initialDownChecks"} {
			if b, ok := f[k]; ok && string(b) == "null" {
				return bad()
			}
		}
		// JSON numbers such as 1.0 are safe integer counters in the original JS validator.
		for _, key := range []string{"totalChecks", "upChecks", "initialDownChecks"} {
			if b, ok := f[key]; ok && string(b) != "null" {
				var n float64
				if json.Unmarshal(b, &n) != nil || math.Trunc(n) != n || n < 0 || n > 9007199254740991 {
					return bad()
				}
				f[key], _ = json.Marshal(int64(n))
			}
		}
		if b, ok := f["history"]; ok {
			var entries []map[string]json.RawMessage
			if json.Unmarshal(b, &entries) != nil {
				return bad()
			}
			for _, h := range entries {
				alive, ok := h["alive"]
				if !ok {
					return bad()
				}
				errValue, hasError := h["error"]
				if string(alive) == "null" {
					if !hasError || string(errValue) != `"probe_execution_failed"` {
						return bad()
					}
				} else {
					if string(alive) != "true" && string(alive) != "false" {
						return bad()
					}
					if hasError && string(errValue) != "null" {
						return bad()
					}
				}
			}
		}
		r, _ = json.Marshal(f)
		m := newMonitor("")
		if json.Unmarshal(r, m) != nil {
			return bad()
		}
		m.IP = trimJS(m.IP)
		if !validIP(m.IP) {
			return bad()
		}
		id := strings.ReplaceAll(m.IP, ".", "-")
		if _, ok := f["id"]; ok && m.ID != id {
			return bad()
		}
		if seen[id] {
			return bad()
		}
		seen[id] = true
		m.ID = id
		if m.Name == "" {
			m.Name = m.IP
		}
		m.Group = groupKey(m.Group)
		if len(m.History) > 60 || !validRTT(m.ResponseTime) || !timestamp(m.LastCheck) {
			return bad()
		}
		measured, up := int64(0), int64(0)
		last := "unknown"
		for _, h := range m.History {
			if h.Time == "" || !timestamp(&h.Time) || !validRTT(h.RTT) {
				return bad()
			}
			if h.Alive == nil {
				if h.Error != probeError || h.RTT != nil {
					return bad()
				}
			} else {
				if h.Error != "" {
					return bad()
				}
				measured++
				last = "down"
				if *h.Alive {
					up++
					last = "up"
				}
			}
		}
		if _, ok := f["totalChecks"]; !ok {
			m.TotalChecks = measured
		}
		if _, ok := f["upChecks"]; !ok {
			m.UpChecks = up
		}
		if !counter(m.TotalChecks) || !counter(m.UpChecks) || m.UpChecks > m.TotalChecks || m.TotalChecks < measured || m.UpChecks < up || m.TotalChecks-m.UpChecks < measured-up {
			return bad()
		}
		if !contains(m.Status, "up", "down", "unknown", "error") {
			return bad()
		}
		if m.Status == "error" {
			if m.CheckError == nil || *m.CheckError != probeError {
				return bad()
			}
		} else if m.CheckError != nil {
			return bad()
		}
		if _, ok := f["lastReachabilityStatus"]; !ok {
			m.LastReachabilityStatus = last
			if contains(m.Status, "up", "down") {
				m.LastReachabilityStatus = m.Status
			}
		}
		if !contains(m.LastReachabilityStatus, "up", "down", "unknown") || (contains(m.Status, "up", "down") && m.LastReachabilityStatus != m.Status) {
			return bad()
		}
		if _, ok := f["initialDownPending"]; !ok {
			m.InitialDownPending = m.TotalChecks == 0 && m.LastReachabilityStatus == "unknown"
		}
		if !counter(m.InitialDownChecks) || m.InitialDownChecks > m.TotalChecks || (m.InitialDownPending && (m.UpChecks != 0 || m.Status == "up")) {
			return bad()
		}
		s.Monitors = append(s.Monitors, m)
	}
	order := []string{}
	seen = map[string]bool{}
	for _, g := range s.GroupOrder {
		g = groupKey(g)
		if !seen[g] {
			order = append(order, g)
			seen[g] = true
		}
	}
	s.GroupOrder = order
	return s, nil
}
func loadState(file string) (State, error) {
	empty := State{Monitors: []*Monitor{}, GroupOrder: []string{}}
	b, e := os.ReadFile(file)
	if os.IsNotExist(e) {
		return empty, nil
	}
	if e == nil {
		var s State
		s, e = decodeState(b)
		if e == nil {
			return s, nil
		}
	}
	// Preserve original bytes even if normalization fails. Never replace the source.
	if b != nil {
		f, err := os.OpenFile(file+".corrupt-"+strings.ReplaceAll(stamp(), ":", "-")+fmt.Sprintf("-%d", time.Now().UnixNano()), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err == nil {
			_, _ = f.Write(b)
			_ = f.Close()
		}
	}
	return empty, errors.New("monitor data invalid or unreadable; startup stopped. Original data was not replaced")
}
func saveState(file string, s State) error {
	now := stamp()
	s.SavedAt = &now
	b, e := json.MarshalIndent(s, "", "  ")
	if e != nil {
		return e
	}
	dir := filepath.Dir(file)
	if e = os.MkdirAll(dir, 0755); e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, ".monitors.*.tmp")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if _, e = f.Write(b); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		return e
	}
	return replaceFile(f.Name(), file)
}
