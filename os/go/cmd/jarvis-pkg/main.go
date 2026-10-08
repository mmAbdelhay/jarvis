// jarvis-pkg is the MCP server for packages, updates, disk usage and the
// tool registry (M1 contracts §1.1, M2 §2, Rafiq M2.5 §3). jarvisd starts
// it as the session user and speaks MCP over stdin/stdout; stderr is for
// logs only.
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperclient"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/pkgtools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/recipes"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
)

var version = "dev"

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-pkg: ")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	home := os.Getenv("HOME")
	deps := pkgtools.Deps{
		Run:      &execx.OSRunner{Env: execx.UserEnv(os.Getenv)},
		Helper:   helperclient.New(),
		FS:       os.DirFS("/"),
		Home:     home,
		Registry: newRegistry(home),
		Recipes:  &recipes.Store{FS: os.DirFS("/"), Dir: recipes.DefaultDir},
	}
	srv := &mcp.Server{Name: "jarvis-pkg", Version: version, Tools: pkgtools.Tools(deps), Redact: redact.String}
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}

// newRegistry wires the registry store. JARVIS_REGISTRY_URL points at
// another index (smoke tests); its signature is still checked against the
// system archive keyring, so the override cannot add trust.
func newRegistry(home string) *registry.Store {
	if !filepath.IsAbs(home) {
		return nil
	}
	indexURL := registry.DefaultIndexURL
	if u := os.Getenv("JARVIS_REGISTRY_URL"); u != "" {
		indexURL = u
	}
	client := registry.NewHTTPClient()
	return &registry.Store{
		Home:   home,
		Client: client,
		Source: &registry.Source{
			IndexURL: indexURL,
			Client:   client,
			Keyring:  func() (*registry.Keyring, error) { return registry.ReadKeyring(registry.KeyringPath) },
			CacheDir: filepath.Join(home, ".cache", "jarvis", "registry"),
		},
	}
}
