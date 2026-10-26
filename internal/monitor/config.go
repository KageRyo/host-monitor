package monitor

import (
	"bufio"
	"fmt"
	"log"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Host                                        string
	Port, Concurrency, MaxMonitors, ManualLimit int
	Interval                                    time.Duration
	AuthEnabled                                 bool
	Username, Password                          string
	WebhookEnabled, InitialDown                 bool
	InitialThreshold                            int
	WebhookURL                                  string
	WebhookTimeout                              time.Duration
	LogMaxBytes                                 int64
	LogMaxFiles                                 int
	LogStdout                                   bool
}

func LoadEnv(file string) error {
	f, err := os.Open(file)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		s := trimJS(scanner.Text())
		if strings.HasPrefix(s, "#") {
			continue
		}
		key, value, ok := strings.Cut(s, "=")
		key = trimJS(key)
		if !ok || key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		value = trimJS(value)
		if len(value) >= 2 && ((value[0] == '"' && value[len(value)-1] == '"') || (value[0] == '\'' && value[len(value)-1] == '\'')) {
			value = value[1 : len(value)-1]
		}
		if err := os.Setenv(key, value); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func ReadConfig(get func(string) (string, bool)) (Config, error) {
	str := func(k, d string) string {
		if v, ok := get(k); ok {
			return v
		}
		return d
	}
	integer := func(k string, d, min, max int) int {
		raw, ok := get(k)
		if !ok {
			return d
		}
		raw = trimJS(raw)
		n, e := strconv.ParseUint(raw, 10, 53)
		if raw == "" || strings.ContainsAny(raw, "+-") || e != nil || n < uint64(min) || n > uint64(max) {
			log.Printf("Invalid %s; using default %d", k, d)
			return d
		}
		return int(n)
	}
	boolean := func(k string, d bool) bool {
		v, ok := get(k)
		if !ok {
			return d
		}
		switch strings.ToLower(trimJS(v)) {
		case "0", "false", "no", "off":
			return false
		}
		return true
	}
	c := Config{Host: trimJS(str("HOST", "0.0.0.0")), Port: integer("PORT", 3000, 1, 65535),
		Interval:    time.Duration(integer("CHECK_INTERVAL", 30000, 1000, 2147483647)) * time.Millisecond,
		Concurrency: integer("PROBE_CONCURRENCY", 5, 1, 9007199254740991), MaxMonitors: integer("MAX_MONITORS", 100, 1, 9007199254740991), ManualLimit: integer("MANUAL_CHECK_LIMIT", 10, 1, 9007199254740991),
		AuthEnabled: boolean("AUTH_ENABLED", false), Username: str("AUTH_USERNAME", ""), Password: str("AUTH_PASSWORD", ""),
		WebhookEnabled: boolean("WEBHOOK_ENABLED", false), InitialDown: boolean("WEBHOOK_INITIAL_DOWN", false), InitialThreshold: integer("WEBHOOK_INITIAL_DOWN_THRESHOLD", 1, 1, 9007199254740991), WebhookURL: str("WEBHOOK_URL", ""), WebhookTimeout: time.Duration(integer("WEBHOOK_TIMEOUT_MS", 5000, 1, 2147483647)) * time.Millisecond,
		LogMaxBytes: int64(integer("LOG_MAX_BYTES", 5242880, 1, 9007199254740991)), LogMaxFiles: integer("LOG_MAX_FILES", 5, 0, 9007199254740991), LogStdout: boolean("LOG_TO_STDOUT", stdoutTerminal())}
	if !validIP(c.Host) {
		return c, fmt.Errorf("invalid HOST; expected an IPv4 bind address")
	}
	if v, ok := get("AUTH_ENABLED"); ok {
		switch strings.ToLower(trimJS(v)) {
		case "1", "true", "yes", "on", "0", "false", "no", "off":
		default:
			return c, fmt.Errorf("invalid AUTH_ENABLED; expected a boolean")
		}
	}
	if c.AuthEnabled && (trimJS(c.Username) == "" || strings.Contains(c.Username, ":") || controls(c.Username) || c.Password == "" || controls(c.Password)) {
		return c, fmt.Errorf("AUTH_ENABLED requires a valid AUTH_USERNAME and nonempty AUTH_PASSWORD")
	}
	return c, nil
}
func stdoutTerminal() bool {
	for _, f := range []*os.File{os.Stdout, os.Stderr} {
		if s, e := f.Stat(); e == nil && s.Mode()&os.ModeCharDevice != 0 {
			return true
		}
	}
	return false
}
func controls(s string) bool {
	for _, r := range s {
		if r < 32 || r == 127 {
			return true
		}
	}
	return false
}
func validIP(s string) bool { a, e := netip.ParseAddr(s); return e == nil && a.Is4() }
