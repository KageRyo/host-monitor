//go:build !windows

package monitor

import (
	"bytes"
	"context"
	"math"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"time"
)

var replyTime = regexp.MustCompile(`time[=<]([0-9]+(?:\.[0-9]+)?)\s*ms`)
var packetLoss = regexp.MustCompile(`\b100(?:\.0+)?% packet loss`)

// A bounded writer prevents unexpectedly large subprocess output from consuming memory.
type cappedBuffer struct{ bytes.Buffer }

func (b *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if b.Len() < 65536 {
		keep := 65536 - b.Len()
		if keep > n {
			keep = n
		}
		_, _ = b.Buffer.Write(p[:keep])
	}
	return n, nil
}
func parsePing(stdout, stderr string, exit int) Result {
	if trimJS(stderr) != "" || !contains(strconv.Itoa(exit), "0", "1", "2") {
		return failedProbe()
	}
	if match := replyTime.FindStringSubmatch(stdout); match != nil && exit == 0 {
		v, e := strconv.ParseFloat(match[1], 64)
		if e == nil {
			v = math.Round(v)
			alive := true
			return Result{Alive: &alive, RTT: &v}
		}
	}
	if packetLoss.MatchString(stdout) {
		alive := false
		return Result{Alive: &alive}
	}
	return failedProbe()
}
func SystemProbe(ctx context.Context, ip string) Result {
	if !validIP(ip) {
		return failedProbe()
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := []string{"-n", "-c", "1", "-W", "3", ip}
	unreachable := 1
	if runtime.GOOS == "darwin" {
		args = []string{"-n", "-c", "1", "-W", "3000", ip}
		unreachable = 2
	}
	cmd := exec.CommandContext(ctx, "ping", args...)
	cmd.Env = append(os.Environ(), "LANG=C", "LC_ALL=C")
	var out, stderr cappedBuffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	err := cmd.Run()
	exit := 0
	if ctx.Err() != nil {
		return failedProbe()
	}
	if err != nil {
		e, ok := err.(*exec.ExitError)
		if !ok || e.ExitCode() != unreachable {
			return failedProbe()
		}
		exit = e.ExitCode()
	}
	return parsePing(out.String(), stderr.String(), exit)
}
