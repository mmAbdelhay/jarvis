// jarvis-pkg is the MCP server for packages and disk usage (contracts §1.1).
// jarvisd starts it as the session user and speaks MCP over stdin/stdout;
// stderr is for logs only.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperclient"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/pkgtools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
)

var version = "dev"

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-pkg: ")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	deps := pkgtools.Deps{
		Run:    &execx.OSRunner{Env: execx.UserEnv(os.Getenv)},
		Helper: helperclient.New(),
		FS:     os.DirFS("/"),
		Home:   os.Getenv("HOME"),
	}
	srv := &mcp.Server{Name: "jarvis-pkg", Version: version, Tools: pkgtools.Tools(deps), Redact: redact.String}
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
