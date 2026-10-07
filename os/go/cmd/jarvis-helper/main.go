// jarvis-helper is the root D-Bus service os.jarvis.Helper1 (contracts §2).
// systemd starts it on D-Bus activation; it exits after five idle minutes.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helper"
)

var version = "dev"

const idleExit = 5 * time.Minute

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-helper: ")
	if os.Geteuid() != 0 {
		log.Fatal("must run as root (it is started by D-Bus activation)")
	}
	conn, err := dbus.ConnectSystemBus()
	if err != nil {
		log.Fatalf("system bus: %v", err)
	}
	defer conn.Close()

	svc := &helper.Service{
		Run:      &execx.OSRunner{Env: execx.HelperEnv()},
		Auth:     helper.SystemAuthorizer{Bus: helper.ConnCaller{Conn: conn}},
		Now:      time.Now,
		ListsAge: helper.AptListsAge(os.DirFS("/var/lib/apt/lists"), time.Now),
	}
	if err := helper.Export(conn, &helper.Object{Svc: svc}); err != nil {
		log.Fatal(err)
	}
	log.Printf("version %s ready", version)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			// A running install holds the service mutex; wait for it so
			// dpkg is never killed midway (the unit allows 35 minutes).
			for svc.IdleFor(time.Now()) == 0 {
				time.Sleep(time.Second)
			}
			return
		case <-tick.C:
			if svc.IdleFor(time.Now()) >= idleExit {
				return
			}
		}
	}
}
