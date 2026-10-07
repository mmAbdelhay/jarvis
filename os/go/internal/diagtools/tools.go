// Package diagtools implements jarvis-diag's MCP tools (contracts §1.2).
// Every string these tools return is redacted by the MCP server before it
// leaves the process (internal/mcp Server.Redact = redact.String).
package diagtools

import (
	"context"
	"io/fs"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

// Resolver is the DNS lookup net.status uses (net.DefaultResolver in main).
type Resolver interface {
	LookupHost(ctx context.Context, host string) ([]string, error)
}

// Deps are jarvis-diag's side effects, injected.
type Deps struct {
	Run      execx.Runner
	Helper   helperapi.Helper
	FS       fs.FS // the root filesystem, for /proc
	Now      func() time.Time
	Resolver Resolver
}

const queryTimeout = 20 * time.Second

func (d Deps) run(ctx context.Context, timeout time.Duration, name string, args ...string) (execx.Result, error) {
	return d.Run.Run(ctx, execx.Cmd{Name: name, Args: args, Timeout: timeout})
}

// Tools returns every jarvis-diag tool.
func Tools(d Deps) []mcp.Tool {
	return d.sysTools()
}
