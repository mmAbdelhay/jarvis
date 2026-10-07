package diagtools

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

var now = time.Date(2026, 10, 7, 10, 0, 0, 0, time.UTC)

func tool(t *testing.T, d Deps, name string) mcp.Tool {
	t.Helper()
	if d.Now == nil {
		d.Now = func() time.Time { return now }
	}
	for _, tl := range Tools(d) {
		if tl.Name == name {
			return tl
		}
	}
	t.Fatalf("no tool %s", name)
	return mcp.Tool{}
}

func call(t *testing.T, d Deps, name, args string) (any, error) {
	t.Helper()
	return tool(t, d, name).Call(context.Background(), json.RawMessage(args))
}

func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// fixture reads a captured command output shared with internal/parse.
func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("../parse/testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func code(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}

// serve runs one request through a real mcp.Server and returns its output.
func serve(t *testing.T, srv *mcp.Server, lines ...string) string {
	t.Helper()
	var out strings.Builder
	if err := srv.Serve(context.Background(), strings.NewReader(strings.Join(lines, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	return out.String()
}
