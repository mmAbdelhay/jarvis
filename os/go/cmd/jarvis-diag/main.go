// jarvis-diag is the MCP server for health, logs, services, network and
// hardware (contracts §1.2). jarvisd starts it as the session user and
// speaks MCP over stdin/stdout; stderr is for logs only. Every string it
// returns is redacted (design §6.3).
package main

import (
	"context"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/diagtools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperclient"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
)

var version = "dev"

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-diag: ")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	deps := diagtools.Deps{
		Run:      &execx.OSRunner{Env: execx.UserEnv(os.Getenv)},
		Helper:   helperclient.New(),
		FS:       os.DirFS("/"),
		Now:      time.Now,
		Resolver: net.DefaultResolver,
	}
	srv := &mcp.Server{Name: "jarvis-diag", Version: version, Tools: diagtools.Tools(deps), Redact: redact.String}
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
