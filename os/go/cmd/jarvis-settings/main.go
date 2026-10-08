// jarvis-settings is the built-in MCP server for desktop settings (Rafiq
// M3 contracts §1), installed as /usr/lib/jarvis/mcp/jarvis-settings and
// started by jarvisd as the session user.
//
// `jarvis-settings restore` re-applies the remembered display scales; the
// labwc session runs it once at login (labwc does not keep scales).
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/godbus/dbus/v5"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
	"github.com/mmAbdelhay/jarvis/os/go/internal/settings"
	"github.com/mmAbdelhay/jarvis/os/go/internal/settingstools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

var version = "dev"

// systemBus connects once, on first use, so tools/list needs no bus.
func systemBus() func() (*dbus.Conn, error) {
	var once sync.Once
	var conn *dbus.Conn
	var err error
	return func() (*dbus.Conn, error) {
		once.Do(func() { conn, err = dbus.ConnectSystemBus() })
		return conn, err
	}
}

func stateDir() string {
	state := os.Getenv("XDG_STATE_HOME")
	if state == "" || !filepath.IsAbs(state) {
		state = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(state, "jarvis", "settings")
}

func deps() settingstools.Deps {
	run := &execx.OSRunner{Env: execx.UserEnv(os.Getenv)}
	return settingstools.Deps{
		Sys: &settings.System{Run: run},
		Sess: &settings.Session{
			Run:            run,
			Display:        func() (string, error) { return wl.Display(os.Getenv, os.ReadDir) },
			Home:           os.Getenv("HOME"),
			StateDir:       stateDir(),
			XKBRules:       "/usr/share/X11/xkb/rules/evdev.lst",
			SystemKeyboard: "/etc/default/keyboard",
			Proc:           "/proc",
			UID:            os.Getuid(),
			Kill:           syscall.Kill,
		},
		BT: &settings.Bluez{Bus: settings.SystemBluezBus{Conn: systemBus()}},
	}
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-settings: ")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	d := deps()
	if len(os.Args) == 2 && os.Args[1] == "restore" {
		if err := d.Sess.RestoreScales(ctx); err != nil {
			log.Fatal(err)
		}
		return
	}
	srv := &mcp.Server{Name: "jarvis-settings", Version: version, Tools: settingstools.Tools(d), Redact: redact.String}
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
