package pkgtools

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

// call runs one tool from Tools(d) by name, as the MCP server would.
func call(t *testing.T, d Deps, name string, args string) (any, error) {
	t.Helper()
	for _, tool := range Tools(d) {
		if tool.Name == name {
			return tool.Call(context.Background(), json.RawMessage(args))
		}
	}
	t.Fatalf("no tool %s", name)
	return nil, nil
}

// asJSON round-trips a result the way the server does, for easy assertions.
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

func code(err error) mcp.Code {
	if err == nil {
		return ""
	}
	return mcp.AsToolError(err).Code
}
