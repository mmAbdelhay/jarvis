package mcp

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
)

func langServer() *Server {
	return &Server{Name: "jarvis-test", Tools: []Tool{{
		Name: "t.lang", Description: "card in the asked language", Risk: RiskConfirm, InputSchema: EmptySchema,
		Call: func(context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil },
		Describe: func(ctx context.Context, _ json.RawMessage) (Description, error) {
			return Description{Title: string(i18n.FromContext(ctx)), Detail: "d", Source: SourceSystem}, nil
		},
	}}}
}

// Rafiq M4 contracts §3: lang is optional ("en" default); jarvisd passes
// the turn language. Review focus 2: no lang is today's English, an
// unknown value is refused, never silently English.
func TestDescribeCarriesLang(t *testing.T) {
	got := run(t, langServer(),
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"t.lang","input":{}}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"t.lang","input":{},"lang":"ar"}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"t.lang","input":{},"lang":"en"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"t.lang","input":{},"lang":"fr"}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"t.lang","input":{},"lang":"ar-EG"}}}`,
	)
	for id, want := range map[string]string{"1": "en", "2": "ar", "3": "en"} {
		r := result(t, got[id])
		if r["isError"] != false || r["structuredContent"].(map[string]any)["title"] != want {
			t.Errorf("id %s: %v, want title %s", id, r, want)
		}
	}
	for _, id := range []string{"4", "5"} {
		r := result(t, got[id])
		if r["isError"] != true || r["structuredContent"].(map[string]any)["code"] != "invalid" {
			t.Errorf("id %s: %v, want invalid", id, r)
		}
	}
}

func TestDescribeSchemaListsLang(t *testing.T) {
	got := run(t, langServer(), `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
	for _, raw := range result(t, got["1"])["tools"].([]any) {
		tool := raw.(map[string]any)
		if tool["name"] != DescribeTool {
			continue
		}
		schema := tool["inputSchema"].(map[string]any)
		lang := schema["properties"].(map[string]any)["lang"].(map[string]any)
		if lang["type"] != "string" || !reflect.DeepEqual(lang["enum"], []any{"en", "ar"}) {
			t.Fatalf("lang schema %v", lang)
		}
		if !reflect.DeepEqual(schema["required"], []any{"tool", "input"}) {
			t.Fatalf("lang must stay optional: required %v", schema["required"])
		}
		return
	}
	t.Fatal("no jarvis.describe in tools/list")
}
