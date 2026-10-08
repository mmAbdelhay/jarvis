// jarvis-apps is the built-in MCP server for apps and windows (Rafiq M3
// contracts §1), installed as /usr/lib/jarvis/mcp/jarvis-apps and started
// by jarvisd as the session user.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/mmAbdelhay/jarvis/os/go/internal/apptools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/desktop"
	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
)

var version = "dev"

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-apps: ")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	home := os.Getenv("HOME")
	deps := apptools.Deps{
		Run:     &execx.OSRunner{Env: execx.UserEnv(os.Getenv)},
		Paths:   homepath.Resolver{Home: home},
		Dirs:    desktop.DefaultDirs(home),
		Windows: apptools.WaylandWindows(os.Getenv, os.ReadDir),
		Display: apptools.WaylandDisplay(os.Getenv, os.ReadDir),
	}
	srv := &mcp.Server{Name: "jarvis-apps", Version: version, Tools: apptools.Tools(deps), Redact: redact.String}
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
