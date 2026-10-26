package monitor

import (
	"context"
	"errors"
	"io/fs"
	"log"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type job struct {
	m     *Monitor
	done  chan struct{}
	saved bool
}
type Service struct {
	mu                        sync.Mutex
	state                     State
	file                      string
	config                    Config
	probe                     Probe
	ctx                       context.Context
	cancel                    context.CancelFunc
	wg                        sync.WaitGroup
	jobs                      map[*Monitor]*job
	queue                     []*job
	active                    int
	checking, closed, started bool
	checkerCancel             context.CancelFunc
	quotaStart                time.Time
	quotaCount                int
	notifier                  *notifier
	assets                    fs.FS
	collator                  *collate.Collator
}

func New(c Config, file string, assets fs.FS, probe Probe) (*Service, error) {
	if c.Concurrency < 1 || c.MaxMonitors < 1 || c.ManualLimit < 1 || c.Interval <= 0 {
		return nil, errors.New("invalid service configuration")
	}
	if c.AuthEnabled && (trimJS(c.Username) == "" || strings.Contains(c.Username, ":") || c.Password == "" || controls(c.Username) || controls(c.Password)) {
		return nil, errors.New("invalid authentication configuration")
	}
	state, e := loadState(file)
	if e != nil {
		return nil, e
	}
	if probe == nil {
		probe = SystemProbe
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Service{state: state, file: file, config: c, probe: probe, ctx: ctx, cancel: cancel, jobs: map[*Monitor]*job{}, assets: assets, collator: collate.New(language.TraditionalChinese)}
	s.notifier = newNotifier(ctx, c)
	return s, nil
}
func (s *Service) Close() {
	s.mu.Lock()
	s.closed = true
	s.cancel()
	s.mu.Unlock()
	s.wg.Wait()
	s.notifier.wait()
}
func (s *Service) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.started {
		return
	}
	s.started = true
	ctx, cancel := context.WithCancel(s.ctx)
	s.checkerCancel = cancel
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		first := time.NewTimer(1500 * time.Millisecond)
		defer first.Stop()
		ticker := time.NewTicker(s.config.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-first.C:
				if ctx.Err() == nil {
					s.backgroundBatch()
				}
			case <-ticker.C:
				if ctx.Err() == nil {
					s.backgroundBatch()
				}
			}
		}
	}()
}
func (s *Service) StopChecker() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.checkerCancel != nil {
		s.checkerCancel()
	}
	s.started = false
}
func (s *Service) backgroundBatch() {
	s.mu.Lock()
	defer s.mu.Unlock()
	jobs, ok := s.beginBatchLocked()
	if !ok {
		return
	}
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.finishBatch(jobs) }()
}
func (s *Service) beginBatchLocked() ([]*job, bool) {
	if s.checking || s.closed {
		return nil, false
	}
	s.checking = true
	list := make([]*job, 0, len(s.state.Monitors))
	for _, m := range s.state.Monitors {
		list = append(list, s.enqueueLocked(m))
	}
	return list, true
}
func (s *Service) finishBatch(jobs []*job) bool {
	saved := true
	for _, j := range jobs {
		<-j.done
		if !j.saved {
			saved = false
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() { s.checking = false }()
	if s.closed {
		return false
	}
	old := s.state.LastGlobalCheck
	now := stamp()
	s.state.LastGlobalCheck = &now
	if s.saveLocked() != nil {
		s.state.LastGlobalCheck = old
		return false
	}
	return saved
}
func (s *Service) saveLocked() error {
	e := saveState(s.file, s.state)
	if e != nil {
		log.Print("Failed to save monitor data")
	}
	return e
}
func (s *Service) enqueueLocked(m *Monitor) *job {
	if j := s.jobs[m]; j != nil {
		return j
	}
	j := &job{m: m, done: make(chan struct{})}
	s.jobs[m] = j
	s.queue = append(s.queue, j)
	s.drainLocked()
	return j
}
func (s *Service) drainLocked() {
	for s.active < s.config.Concurrency && len(s.queue) > 0 {
		j := s.queue[0]
		s.queue[0] = nil
		s.queue = s.queue[1:]
		s.active++
		s.wg.Add(1)
		go s.runJob(j)
	}
}
func (s *Service) hasLocked(m *Monitor) bool {
	for _, other := range s.state.Monitors {
		if other == m {
			return true
		}
	}
	return false
}
func (s *Service) runJob(j *job) {
	defer s.wg.Done()
	s.mu.Lock()
	exists := s.hasLocked(j.m) && !s.closed
	ip := j.m.IP
	s.mu.Unlock()
	result := failedProbe()
	if exists {
		result = normalizeResult(s.probe(s.ctx, ip))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		j.saved = false
	} else if !s.hasLocked(j.m) {
		j.saved = true
	} else {
		j.saved = s.applyLocked(j.m, result)
	}
	delete(s.jobs, j.m)
	s.active--
	close(j.done)
	s.drainLocked()
}
func (s *Service) applyLocked(m *Monitor, r Result) bool {
	old := *m
	old.History = append([]Entry{}, m.History...)
	previous := m.LastReachabilityStatus
	now := stamp()
	m.LastCheck = &now
	m.ResponseTime = r.RTT
	m.CheckError = nil
	m.Status = "down"
	if r.Error != "" {
		m.Status = "error"
		err := probeError
		m.CheckError = &err
	} else {
		if *r.Alive {
			m.Status = "up"
			m.UpChecks++
		}
		m.TotalChecks++
		m.LastReachabilityStatus = m.Status
	}
	if r.Error != "" || *r.Alive {
		m.InitialDownChecks = 0
	}
	m.History = append(m.History, Entry{Time: now, Alive: r.Alive, RTT: r.RTT, Error: r.Error})
	if len(m.History) > 60 {
		m.History = append([]Entry{}, m.History[len(m.History)-60:]...)
	}
	initial := false
	if r.Error == "" && m.InitialDownPending {
		if *r.Alive || !s.config.WebhookEnabled || !s.config.InitialDown {
			m.InitialDownPending = false
			m.InitialDownChecks = 0
		} else {
			m.InitialDownChecks++
			if m.InitialDownChecks >= int64(s.config.InitialThreshold) {
				initial = true
				m.InitialDownPending = false
			}
		}
	}
	if r.Error != "" {
		log.Print("Probe execution failed; check ping installation, permissions, and monitoring-node configuration")
	}
	if s.saveLocked() != nil {
		*m = old
		return false
	}
	if initial || (r.Error == "" && contains(previous, "up", "down") && previous != m.Status) {
		if initial {
			previous = "unknown"
		}
		s.notifier.notify(map[string]any{"event": "monitor.status_changed", "monitor": map[string]string{"id": m.ID, "ip": m.IP, "name": m.Name, "group": m.Group}, "previousStatus": previous, "status": m.Status, "checkedAt": m.LastCheck, "responseTime": m.ResponseTime})
	}
	return true
}
func (s *Service) findLocked(id string) *Monitor {
	for _, m := range s.state.Monitors {
		if m.ID == id {
			return m
		}
	}
	return nil
}

type listedMonitor struct {
	*Monitor
	GroupLabel string `json:"groupLabel"`
}

func (s *Service) sortedLocked() []listedMonitor {
	order := collationOrder{collator: s.collator, keys: make(map[string][]byte, len(s.state.Monitors)+4)}
	groups := []string{}
	seen := map[string]bool{}
	for _, m := range s.state.Monitors {
		if !seen[m.Group] {
			seen[m.Group] = true
			groups = append(groups, m.Group)
		}
	}
	sort.SliceStable(groups, func(i, j int) bool {
		if len(s.state.GroupOrder) == 0 {
			if groups[i] == "server" {
				return true
			}
			if groups[j] == "server" {
				return false
			}
		}
		return order.compare(groups[i], groups[j]) < 0
	})
	ordered := []string{}
	for _, g := range s.state.GroupOrder {
		if seen[g] {
			ordered = append(ordered, g)
			delete(seen, g)
		}
	}
	for _, g := range groups {
		if seen[g] {
			ordered = append(ordered, g)
		}
	}
	result := []listedMonitor{}
	for _, g := range ordered {
		items := []*Monitor{}
		for _, m := range s.state.Monitors {
			if m.Group == g {
				items = append(items, m)
			}
		}
		sort.SliceStable(items, func(i, j int) bool {
			a, b := items[i].Name, items[j].Name
			if a == "" {
				a = items[i].IP
			}
			if b == "" {
				b = items[j].IP
			}
			return order.compare(a, b) < 0
		})
		for _, m := range items {
			result = append(result, listedMonitor{m, groupLabel(g)})
		}
	}
	return result
}
func (s *Service) statsLocked() map[string]any {
	stats := map[string]any{"total": len(s.state.Monitors), "up": 0, "down": 0, "error": 0, "unknown": 0, "avgUptime": nil, "lastGlobalCheck": s.state.LastGlobalCheck}
	measured, sum := 0, 0.0
	for _, m := range s.state.Monitors {
		stats[m.Status] = stats[m.Status].(int) + 1
		if m.TotalChecks > 0 {
			measured++
			sum += float64(m.UpChecks) / float64(m.TotalChecks) * 100
		}
	}
	if measured > 0 {
		stats["avgUptime"] = math.Round(sum/float64(measured)*10) / 10
	}
	return stats
}
