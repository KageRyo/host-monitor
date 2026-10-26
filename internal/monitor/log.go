package monitor

import (
	"io"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

type rotatingLog struct {
	mu      sync.Mutex
	file    string
	max     int64
	backups int
	stdout  bool
}

func NewLog(c Config, file string) io.Writer {
	return &rotatingLog{file: file, max: c.LogMaxBytes, backups: c.LogMaxFiles, stdout: c.LogStdout}
}
func (l *rotatingLog) Write(b []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.stdout {
		_, _ = os.Stdout.Write(b)
	}
	if e := os.MkdirAll(filepath.Dir(l.file), 0755); e != nil {
		return 0, e
	}
	if info, e := os.Stat(l.file); e == nil && info.Size() > 0 && info.Size()+int64(len(b)) > l.max {
		if l.backups > 0 {
			_ = os.Remove(l.file + "." + strconv.Itoa(l.backups))
			for i := l.backups - 1; i >= 1; i-- {
				_ = os.Rename(l.file+"."+strconv.Itoa(i), l.file+"."+strconv.Itoa(i+1))
			}
			if e = os.Rename(l.file, l.file+".1"); e != nil {
				return 0, e
			}
		} else if e = os.Remove(l.file); e != nil {
			return 0, e
		}
	}
	f, e := os.OpenFile(l.file, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if e != nil {
		return 0, e
	}
	n, e := f.Write(b)
	ce := f.Close()
	if e == nil {
		e = ce
	}
	return n, e
}
