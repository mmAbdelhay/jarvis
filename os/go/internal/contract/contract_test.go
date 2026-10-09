// Package contract pins both MCP servers' tools/list output to
// docs/superpowers/specs/2026-10-07-jarvis-os-m1-contracts.md §1 and §6.1
// and 2026-10-08-jarvis-os-m2-contracts.md §2 and
// 2026-10-09-rafiq-m2.5-contracts.md §3. If
// a tool, risk, secret, batch or input property changes, this test fails until the
// contract file is changed first (the contract says: change it there first).
package contract

import (
	"bufio"
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/diagtools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/pkgtools"
)

type want struct {
	risk     string
	secrets  []string
	props    []string // every input property
	required []string
}

var pkgContract = map[string]want{
	"pkg.search":         {"safe", nil, []string{"limit", "query"}, []string{"query"}},
	"pkg.info":           {"safe", nil, []string{"id", "source"}, []string{"id", "source"}},
	"pkg.list_installed": {"safe", nil, []string{"source"}, nil},
	"disk.usage":         {"safe", nil, []string{"path"}, nil},
	"pkg.install":        {"confirm", nil, []string{"items"}, []string{"items"}},
	"pkg.remove":         {"confirm", nil, []string{"items"}, []string{"items"}},
	"updates.list":       {"safe", nil, nil, nil},
	"updates.apply":      {"confirm", nil, []string{"items"}, []string{"items"}},
	// Rafiq M2.5 contracts §3.
	"registry.search":  {"safe", nil, []string{"query"}, []string{"query"}},
	"registry.install": {"confirm", nil, []string{"id", "version"}, []string{"id", "version"}},
	"registry.remove":  {"confirm", nil, []string{"id"}, []string{"id"}},
	"registry.list":    {"safe", nil, nil, nil}, // hidden, contracts §7.8
	// Rafiq M4 contracts §6.1: jarvisd executes recipes itself.
	"recipes.list": {"safe", nil, nil, nil},
}

// hiddenTools are the contract tools that must declare _meta.jarvis.hidden.
var hiddenTools = map[string]bool{"registry.list": true}

// batchTools declare _meta.jarvis.batch (contracts §6.1); no other tool may.
var batchTools = map[string]string{"pkg.install": "items", "pkg.remove": "items", "updates.apply": "items"}

var diagContract = map[string]want{
	"sys.health":        {"safe", nil, nil, nil},
	"logs.query":        {"safe", nil, []string{"grep", "limit", "priority", "sinceMinutes", "unit"}, nil},
	"svc.status":        {"safe", nil, []string{"scope", "unit"}, []string{"unit"}},
	"svc.list_failed":   {"safe", nil, nil, nil},
	"net.status":        {"safe", nil, nil, nil},
	"net.wifi_scan":     {"safe", nil, nil, nil},
	"hw.info":           {"safe", nil, nil, nil},
	"svc.restart":       {"confirm", nil, []string{"scope", "unit"}, []string{"unit"}},
	"net.connection_up": {"confirm", nil, []string{"id"}, []string{"id"}},
	"net.wifi_connect":  {"confirm", []string{"password"}, []string{"password", "ssid"}, []string{"ssid"}},
	"net.radio_on":      {"confirm", nil, nil, nil},
}

type listedTool struct {
	Name        string `json:"name"`
	InputSchema struct {
		Type       string                     `json:"type"`
		Properties map[string]json.RawMessage `json:"properties"`
		Required   []string                   `json:"required"`
		Additional *bool                      `json:"additionalProperties"`
	} `json:"inputSchema"`
	Meta struct {
		Jarvis struct {
			Risk    string   `json:"risk"`
			Hidden  *bool    `json:"hidden"`
			Secrets []string `json:"secrets"`
			Batch   string   `json:"batch"`
		} `json:"jarvis"`
	} `json:"_meta"`
}

func list(t *testing.T, srv *mcp.Server) []listedTool {
	t.Helper()
	var out strings.Builder
	in := `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n"
	if err := srv.Serve(context.Background(), strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var resp struct {
		Result struct {
			Tools []listedTool `json:"tools"`
		} `json:"result"`
	}
	sc := bufio.NewScanner(strings.NewReader(out.String()))
	sc.Scan()
	if err := json.Unmarshal(sc.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	return resp.Result.Tools
}

func sorted(s []string) []string {
	c := append([]string{}, s...)
	sort.Strings(c)
	return c
}

func eq(a, b []string) bool { return strings.Join(sorted(a), ",") == strings.Join(sorted(b), ",") }

func check(t *testing.T, server string, tools []listedTool, contract map[string]want) {
	seen := map[string]bool{}
	for _, tl := range tools {
		seen[tl.Name] = true
		m := tl.Meta.Jarvis
		if m.Hidden == nil || m.Secrets == nil {
			t.Errorf("%s %s: _meta.jarvis must carry hidden and secrets explicitly", server, tl.Name)
		}
		if tl.InputSchema.Type != "object" || tl.InputSchema.Additional == nil || *tl.InputSchema.Additional {
			t.Errorf("%s %s: schema must be an object with additionalProperties:false", server, tl.Name)
		}
		if m.Batch != batchTools[tl.Name] {
			t.Errorf("%s %s: batch = %q, contract says %q", server, tl.Name, m.Batch, batchTools[tl.Name])
		}
		if tl.Name == mcp.DescribeTool {
			var props []string
			for p := range tl.InputSchema.Properties {
				props = append(props, p)
			}
			if m.Risk != "safe" || !*m.Hidden || !eq(tl.InputSchema.Required, []string{"input", "tool"}) || !eq(props, []string{"input", "lang", "tool"}) {
				t.Errorf("%s jarvis.describe meta/schema wrong (Rafiq M4 contracts §3: optional lang)", server)
			}
			continue
		}
		w, ok := contract[tl.Name]
		if !ok {
			t.Errorf("%s exposes %s, which is not in the contract", server, tl.Name)
			continue
		}
		var props []string
		for p := range tl.InputSchema.Properties {
			props = append(props, p)
		}
		if m.Risk != w.risk || *m.Hidden != hiddenTools[tl.Name] || !eq(m.Secrets, w.secrets) || !eq(props, w.props) || !eq(tl.InputSchema.Required, w.required) {
			t.Errorf("%s %s: risk=%s secrets=%v props=%v required=%v; contract says risk=%s secrets=%v props=%v required=%v",
				server, tl.Name, m.Risk, m.Secrets, props, tl.InputSchema.Required, w.risk, w.secrets, w.props, w.required)
		}
	}
	for name := range contract {
		if !seen[name] {
			t.Errorf("%s is missing contract tool %s", server, name)
		}
	}
	if !seen[mcp.DescribeTool] {
		t.Errorf("%s is missing %s", server, mcp.DescribeTool)
	}
}

func TestJarvisPkgMatchesContract(t *testing.T) {
	check(t, "jarvis-pkg", list(t, &mcp.Server{Name: "jarvis-pkg", Tools: pkgtools.Tools(pkgtools.Deps{})}), pkgContract)
}

func TestJarvisDiagMatchesContract(t *testing.T) {
	check(t, "jarvis-diag", list(t, &mcp.Server{Name: "jarvis-diag", Tools: diagtools.Tools(diagtools.Deps{})}), diagContract)
}

func TestUpdatesApplyContractBounds(t *testing.T) {
	for _, tool := range list(t, &mcp.Server{Name: "jarvis-pkg", Tools: pkgtools.Tools(pkgtools.Deps{})}) {
		if tool.Name != "updates.apply" {
			continue
		}
		var items struct {
			Min int `json:"minItems"`
			Max int `json:"maxItems"`
		}
		if err := json.Unmarshal(tool.InputSchema.Properties["items"], &items); err != nil {
			t.Fatal(err)
		}
		if items.Min != 1 || items.Max != 200 {
			t.Fatalf("updates.apply items bounds = %d..%d, want 1..200", items.Min, items.Max)
		}
		return
	}
	t.Fatal("missing updates.apply")
}

// Rafiq M4 contracts §6.1 assigns recipe execution to jarvisd.
func TestRecipesRunIsNotExposed(t *testing.T) {
	for _, tool := range list(t, &mcp.Server{Name: "jarvis-pkg", Tools: pkgtools.Tools(pkgtools.Deps{})}) {
		if tool.Name == "recipes.run" {
			t.Fatal("jarvis-pkg must not expose recipes.run")
		}
	}
}
