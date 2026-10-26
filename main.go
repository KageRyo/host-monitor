package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/KageRyo/host-monitor/internal/monitor"
)

//go:embed public
var assets embed.FS

func main() {
	if e := run(); e != nil {
		log.Print(e)
		os.Exit(1)
	}
}
func run() error {
	dir := flag.String("dir", ".", "directory containing .env, data/ and logs/")
	flag.Parse()
	root, e := filepath.Abs(*dir)
	if e != nil {
		return e
	}
	if e = monitor.LoadEnv(filepath.Join(root, ".env")); e != nil {
		log.Print("Failed to load .env file")
	}
	c, e := monitor.ReadConfig(os.LookupEnv)
	if e != nil {
		return e
	}
	log.SetOutput(monitor.NewLog(c, filepath.Join(root, "logs", "monitor.log")))
	public, e := fs.Sub(assets, "public")
	if e != nil {
		return e
	}
	service, e := monitor.New(c, filepath.Join(root, "data", "monitors.json"), public, nil)
	if e != nil {
		return e
	}
	defer service.Close()
	listener, e := net.Listen("tcp4", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
	if e != nil {
		return errors.New("HTTP listener failed; check HOST and PORT")
	}
	server := &http.Server{Handler: service, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 20}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() { done <- server.Serve(listener) }()
	localHost := c.Host
	if localHost == "0.0.0.0" {
		localHost = "127.0.0.1"
	}
	log.Printf("Dashboard: http://%s", net.JoinHostPort(localHost, strconv.Itoa(c.Port)))
	if c.Host == "0.0.0.0" {
		if addresses, err := net.InterfaceAddrs(); err == nil {
			for _, address := range addresses {
				if ipnet, ok := address.(*net.IPNet); ok && ipnet.IP.To4() != nil && !ipnet.IP.IsLoopback() {
					log.Printf("LAN: http://%s", net.JoinHostPort(ipnet.IP.String(), strconv.Itoa(c.Port)))
				}
			}
		}
	}
	service.Start()
	log.Printf("Host Monitor listening at http://%s; check interval %s", listener.Addr(), c.Interval)
	select {
	case e = <-done:
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	case <-ctx.Done():
	}
	// Cancel probes before waiting for handlers that may be awaiting their results.
	service.Close()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if e = server.Shutdown(shutdown); e != nil {
		_ = server.Close()
		return e
	}
	return nil
}
