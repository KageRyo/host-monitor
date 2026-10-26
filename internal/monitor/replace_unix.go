//go:build !windows

package monitor

import "os"

func replaceFile(from, to string) error { return os.Rename(from, to) }
