package official

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/registry"
)

func TestEntryFromToolsSkipsHiddenAndValidates(t *testing.T) {
	noop := func(context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil }
	m := Manifest{ID: "jarvis-demo", Name: "Demo", Description: "A demo.", Permissions: registry.Permissions{Network: true}}
	e := Entry(m, "0.3.0", []mcp.Tool{
		{Name: "demo.read", Risk: mcp.RiskSafe, Call: noop},
		{Name: "demo.secret", Risk: mcp.RiskSafe, Hidden: true, Call: noop},
	})
	if e.Tier != registry.TierOfficial || e.Artifact.Runtime != registry.RuntimeGoStatic || e.Version != "0.3.0" {
		t.Fatalf("entry %+v", e)
	}
	if !reflect.DeepEqual(e.Tools, []registry.ToolDecl{{Name: "demo.read", Risk: "safe"}}) {
		t.Fatalf("tools %+v", e.Tools)
	}
	if e.Permissions.Paths == nil || !e.Permissions.Network {
		t.Fatalf("permissions %+v", e.Permissions)
	}
	if err := e.Validate(); err == nil {
		t.Fatal("an entry without artifact URL and checksum must not validate yet")
	}
	e.Artifact.URL = "https://example.org/jarvis-demo-0.3.0.tar.gz"
	e.Artifact.SHA256 = strings.Repeat("0", 64)
	if err := e.Validate(); err != nil {
		t.Fatal(err)
	}
}
