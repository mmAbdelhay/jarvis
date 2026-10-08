// Package official is what the three official registry servers
// (jarvis-files, jarvis-web, jarvis-clock; Rafiq M2.5 contracts §3) share:
// their registry manifest and the stdio main loop with redaction on.
package official

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/redact"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
)

// Manifest is what a server says about itself in the registry.
type Manifest struct {
	ID          string
	Name        string
	Description string
	Permissions registry.Permissions
}

// Entry is the server's registry entry built from its own tool list, so
// the index can never drift from the code. Artifact URL and SHA-256 are
// left empty for tools/regpack to fill in after packing.
func Entry(m Manifest, version string, tools []mcp.Tool) registry.Entry {
	decls := []registry.ToolDecl{}
	for _, t := range tools {
		if t.Hidden {
			continue
		}
		decls = append(decls, registry.ToolDecl{Name: t.Name, Risk: string(t.Risk)})
	}
	paths := append([]string{}, m.Permissions.Paths...)
	return registry.Entry{
		ID: m.ID, Name: m.Name, Description: m.Description,
		Tier: registry.TierOfficial, Version: version,
		Artifact:    registry.Artifact{Runtime: registry.RuntimeGoStatic},
		Permissions: registry.Permissions{Network: m.Permissions.Network, Paths: paths},
		Tools:       decls,
	}
}

// Serve speaks MCP on stdin/stdout until stdin closes or SIGINT/SIGTERM.
// Every string leaving the process goes through redact.String.
func Serve(m Manifest, version string, tools []mcp.Tool) {
	log.SetFlags(0)
	log.SetPrefix(m.ID + ": ")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	srv := &mcp.Server{Name: m.ID, Version: version, Tools: tools, Redact: redact.String}
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Fatal(err)
	}
}
