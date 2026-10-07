// jarvis-installer-backend is the root D-Bus service os.jarvis.Installer1
// (M2 contracts §1), live ISO only. With no arguments it serves the bus
// (started by D-Bus activation). Two read-only commands help on real
// hardware without risk:
//
//	jarvis-installer-backend probe [--allow-loop]               print ProbeResult
//	jarvis-installer-backend plan [--allow-loop] choices.json   print the plan and every disk command it would run
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helper"
	"github.com/mmAbdelhay/jarvis/os/go/internal/install"
)

var version = "dev"

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-installer-backend: ")
	args := os.Args[1:]
	allowLoop := false
	var rest []string
	for _, a := range args {
		if a == "--allow-loop" {
			allowLoop = true
		} else {
			rest = append(rest, a)
		}
	}
	args = rest
	if os.Geteuid() != 0 {
		log.Fatal("must run as root")
	}
	pd := install.ProbeDeps{Run: &execx.OSRunner{Env: execx.HelperEnv()}, Files: &files.OS{}, HTTP: &http.Client{}, AllowLoop: allowLoop}
	switch {
	case len(args) == 0:
		serve(pd)
	case args[0] == "probe" && len(args) == 1:
		p, err := install.Probe(context.Background(), pd)
		if err != nil {
			log.Fatal(err)
		}
		printJSON(p)
	case args[0] == "plan" && len(args) == 2:
		dryRun(pd, args[1])
	case args[0] == "--version":
		fmt.Println(version)
	default:
		log.Fatal("usage: jarvis-installer-backend [probe | plan choices.json] [--allow-loop]")
	}
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func dryRun(pd install.ProbeDeps, choicesPath string) {
	raw, err := os.ReadFile(choicesPath)
	if err != nil {
		log.Fatal(err)
	}
	c, err := install.DecodeChoices(raw)
	if err != nil {
		log.Fatal(err)
	}
	p, err := install.Probe(context.Background(), pd)
	if err != nil {
		log.Fatal(err)
	}
	pl, err := install.MakePlan(c, p, "dry-run")
	if err != nil {
		log.Fatal(err)
	}
	printJSON(pl.Public)
	fmt.Println("\nCommands that would change disks (nothing was run):")
	for _, line := range install.DryRun(pl) {
		fmt.Println("  " + line)
	}
}

func serve(pd install.ProbeDeps) {
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		log.Fatalf("system bus: %v", err)
	}
	defer conn.Close()
	if err := os.MkdirAll(install.RunDir, 0o755); err != nil {
		log.Fatal(err)
	}
	// World-readable: the installer UI offers "Save log to USB". The log is
	// redacted and never holds a password or passphrase.
	logFile, err := os.OpenFile(install.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		log.Fatal(err)
	}
	defer logFile.Close()
	b := &install.Backend{
		Auth:    helper.SystemAuthorizer{Bus: helper.ConnCaller{Conn: conn}},
		ProbeFn: func(ctx context.Context) (install.ProbeResult, error) { return install.Probe(ctx, pd) },
		Deps: install.Deps{
			Run:      &execx.OSRunner{Env: execx.HelperEnv()},
			Files:    pd.Files,
			Log:      install.NewLogger(logFile, time.Now),
			HTTP:     &http.Client{},
			Now:      time.Now,
			ModelRun: func(port int) execx.Runner { return &execx.OSRunner{Env: install.ModelEnv(port)} },
			FreePort: install.FreeLoopbackPort,
			DiskUsed: install.DiskUsed,
		},
	}
	if err := install.Export(conn, &install.Object{B: b}); err != nil {
		log.Fatal(err)
	}
	log.Printf("version %s ready", version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	if b.Busy() {
		// Never leave a disk half-written because the session ended.
		log.Printf("waiting for the running installation to finish")
		b.Wait()
	}
}
