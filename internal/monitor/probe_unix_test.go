//go:build !windows

package monitor

import "testing"

func TestPingParsing(t *testing.T) {
	up := "64 bytes from 127.0.0.1: icmp_seq=1 ttl=64 time=0.041 ms\n1 packets transmitted, 1 received, 0% packet loss"
	down := "1 packets transmitted, 0 received, 100% packet loss"
	r := parsePing(up, "", 0)
	if r.Alive == nil || !*r.Alive || r.RTT == nil || *r.RTT != 0 {
		t.Fatal(r)
	}
	for _, exit := range []int{0, 1, 2} {
		r = parsePing(down, "", exit)
		if r.Alive == nil || *r.Alive || r.RTT != nil {
			t.Fatal(r)
		}
	}
	for _, r := range []Result{parsePing("permission denied", "", 1), parsePing(down, "permission denied", 1), parsePing(down, "", 3), parsePing("unparseable", "", 0)} {
		if r.Error != probeError || r.Alive != nil {
			t.Fatal(r)
		}
	}
}
