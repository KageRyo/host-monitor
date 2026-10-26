package monitor

import (
	"context"
	"math"
)

type Result struct {
	Alive *bool
	RTT   *float64
	Error string
}
type Probe func(context.Context, string) Result

func failedProbe() Result { return Result{Error: probeError} }
func normalizeResult(r Result) Result {
	if r.Error != "" || r.Alive == nil {
		return failedProbe()
	}
	if !*r.Alive || !validRTT(r.RTT) {
		r.RTT = nil
	} else if r.RTT != nil {
		v := math.Round(*r.RTT)
		r.RTT = &v
	}
	return r
}
