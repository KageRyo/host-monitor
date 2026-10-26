package monitor

import (
	"context"
	"encoding/binary"
	"net/netip"
	"runtime"
	"syscall"
	"unsafe"
)

var icmpDLL = syscall.NewLazyDLL("iphlpapi.dll")
var icmpCreate = icmpDLL.NewProc("IcmpCreateFile")
var icmpClose = icmpDLL.NewProc("IcmpCloseHandle")
var icmpSend = icmpDLL.NewProc("IcmpSendEcho")

// Windows IP Helper avoids raw sockets and locale-dependent ping output.
// The synchronous native call is bounded to 3000ms; shutdown waits for it.
func SystemProbe(ctx context.Context, ip string) Result {
	if ctx.Err() != nil {
		return failedProbe()
	}
	a, e := netip.ParseAddr(ip)
	if e != nil || !a.Is4() {
		return failedProbe()
	}
	for _, proc := range []*syscall.LazyProc{icmpCreate, icmpClose, icmpSend} {
		if proc.Find() != nil {
			return failedProbe()
		}
	}
	handle, _, _ := icmpCreate.Call()
	if handle == ^uintptr(0) {
		return failedProbe()
	}
	defer icmpClose.Call(handle)
	address := a.As4()
	payload := []byte("host-monitor")
	reply := make([]byte, 256)
	n, _, callErr := icmpSend.Call(handle, uintptr(binary.LittleEndian.Uint32(address[:])), uintptr(unsafe.Pointer(&payload[0])), uintptr(len(payload)), 0, uintptr(unsafe.Pointer(&reply[0])), uintptr(len(reply)), 3000)
	runtime.KeepAlive(payload)
	runtime.KeepAlive(reply)
	if ctx.Err() != nil {
		return failedProbe()
	}
	status := uint32(0)
	if n == 0 {
		errno, ok := callErr.(syscall.Errno)
		if !ok {
			return failedProbe()
		}
		status = uint32(errno)
	} else {
		status = binary.LittleEndian.Uint32(reply[4:8])
	}
	if n > 0 && status == 0 {
		alive := true
		rtt := float64(binary.LittleEndian.Uint32(reply[8:12]))
		return Result{Alive: &alive, RTT: &rtt}
	}
	// Reachability outcomes; local API/configuration failures remain tool errors.
	switch status {
	case 11002, 11003, 11004, 11005, 11010, 11013, 11014:
		alive := false
		return Result{Alive: &alive}
	}
	return failedProbe()
}
