package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func testServer() *Server {
	type echoArgs struct {
		Text string `json:"text"`
	}
	return &Server{
		Name:    "jarvis-test",
		Version: "0.0.0",
		Redact:  func(s string) string { return strings.ReplaceAll(s, "hunter2", "[redacted:secret]") },
		Tools: []Tool{
			{
				Name: "t.echo", Description: "echo", Risk: RiskSafe,
				InputSchema: `{"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}`,
				Call: func(_ context.Context, raw json.RawMessage) (any, error) {
					var a echoArgs
					if err := DecodeArgs(raw, &a); err != nil {
						return nil, err
					}
					return map[string]any{"text": a.Text, "n": 9007199254740993}, nil
				},
			},
			{
				Name: "t.fail", Description: "fail", Risk: RiskSafe, InputSchema: EmptySchema,
				Call: func(context.Context, json.RawMessage) (any, error) {
					return nil, Errorf(CodeNotFound, "no such thing: password hunter2")
				},
			},
			{
				Name: "t.plainerr", Description: "plain error", Risk: RiskSafe, InputSchema: EmptySchema,
				Call: func(context.Context, json.RawMessage) (any, error) { return nil, errors.New("boom") },
			},
			{
				Name: "t.panic", Description: "panic", Risk: RiskSafe, InputSchema: EmptySchema,
				Call: func(context.Context, json.RawMessage) (any, error) { panic("bad") },
			},
			{
				Name: "t.block", Description: "blocks until cancelled", Risk: RiskSafe, InputSchema: EmptySchema,
				Call: func(ctx context.Context, _ json.RawMessage) (any, error) {
					<-ctx.Done()
					return nil, ctx.Err()
				},
			},
			{
				Name: "t.batch", Description: "batched", Risk: RiskConfirm, Batch: "items",
				InputSchema: `{"type":"object","properties":{"items":{"type":"array","items":{"type":"string"}}},"required":["items"],"additionalProperties":false}`,
				Call:        func(context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil },
				Describe: func(context.Context, json.RawMessage) (Description, error) {
					return Description{Title: "x", Detail: "y", Source: SourceDebian}, nil
				},
			},
			{
				Name: "t.act", Description: "gated", Risk: RiskConfirm, Secrets: []string{"password"},
				InputSchema: `{"type":"object","properties":{"ssid":{"type":"string"},"password":{"type":"string"}},"required":["ssid"],"additionalProperties":false}`,
				Call:        func(context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil },
				Describe: func(_ context.Context, raw json.RawMessage) (Description, error) {
					var a struct {
						SSID string `json:"ssid"`
					}
					if err := DecodeArgs(raw, &a); err != nil {
						return Description{}, err
					}
					return Description{Title: "Connect to " + a.SSID, Detail: "d", Source: SourceNetwork}, nil
				},
			},
		},
	}
}

// run feeds lines to a server and returns responses keyed by id.
func run(t *testing.T, s *Server, lines ...string) map[string]map[string]any {
	t.Helper()
	var out bytes.Buffer
	if err := s.Serve(context.Background(), strings.NewReader(strings.Join(lines, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	got := map[string]map[string]any{}
	sc := bufio.NewScanner(&out)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("server wrote non-JSON line %q", sc.Text())
		}
		id, _ := json.Marshal(m["id"])
		got[string(id)] = m
	}
	return got
}

func result(t *testing.T, resp map[string]any) map[string]any {
	t.Helper()
	r, ok := resp["result"].(map[string]any)
	if !ok {
		t.Fatalf("no result in %v", resp)
	}
	return r
}

func TestInitializeAnswersProtocolVersion(t *testing.T) {
	got := run(t, testServer(), `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"jarvisd","version":"1"}}}`)
	r := result(t, got["1"])
	if r["protocolVersion"] != "2025-06-18" {
		t.Fatalf("protocolVersion = %v", r["protocolVersion"])
	}
	if r["serverInfo"].(map[string]any)["name"] != "jarvis-test" {
		t.Fatal("serverInfo.name wrong")
	}
}

func TestToolsListCarriesJarvisMetaAndHiddenDescribe(t *testing.T) {
	got := run(t, testServer(), `{"jsonrpc":"2.0","id":"a","method":"tools/list"}`)
	tools := result(t, got[`"a"`])["tools"].([]any)
	meta := map[string]map[string]any{}
	for _, raw := range tools {
		tool := raw.(map[string]any)
		meta[tool["name"].(string)] = tool["_meta"].(map[string]any)["jarvis"].(map[string]any)
		if _, ok := tool["inputSchema"].(map[string]any); !ok {
			t.Errorf("%v: inputSchema is not an object", tool["name"])
		}
	}
	if m := meta["t.act"]; m["risk"] != "confirm" || m["hidden"] != false || len(m["secrets"].([]any)) != 1 {
		t.Errorf("t.act meta = %v", m)
	}
	if m := meta["t.echo"]; m["risk"] != "safe" || len(m["secrets"].([]any)) != 0 {
		t.Errorf("t.echo meta = %v (secrets must be [] not null)", m)
	}
	if meta["t.batch"]["batch"] != "items" {
		t.Errorf("t.batch meta = %v, want batch \"items\"", meta["t.batch"])
	}
	if _, ok := meta["t.echo"]["batch"]; ok {
		t.Error("batch must be absent on tools that do not declare it")
	}
	if m := meta[DescribeTool]; m["risk"] != "safe" || m["hidden"] != true {
		t.Errorf("describe meta = %v", m)
	}
}

func TestToolsCallReturnsStructuredContentAndSameJSONText(t *testing.T) {
	got := run(t, testServer(), `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"t.echo","arguments":{"text":"password=hunter2"}}}`)
	r := result(t, got["2"])
	if r["isError"] != false {
		t.Fatalf("isError = %v", r["isError"])
	}
	sc := r["structuredContent"].(map[string]any)
	if sc["text"] != "password=[redacted:secret]" {
		t.Fatalf("result string not redacted: %v", sc["text"])
	}
	text := r["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(text, `"n":9007199254740993`) {
		t.Fatalf("large integer lost precision or text differs: %s", text)
	}
	var fromText map[string]any
	json.Unmarshal([]byte(text), &fromText)
	if fromText["text"] != sc["text"] {
		t.Fatal("content text and structuredContent disagree")
	}
}

func TestToolErrorsAreTypedAndRedacted(t *testing.T) {
	got := run(t, testServer(),
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"t.fail","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"t.plainerr"}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"t.panic","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"t.echo","arguments":{"text":"x","extra":1}}}`,
	)
	want := map[string]string{"3": "not_found", "4": "failed", "5": "failed", "6": "invalid"}
	for id, code := range want {
		r := result(t, got[id])
		sc := r["structuredContent"].(map[string]any)
		if r["isError"] != true || sc["code"] != code {
			t.Errorf("id %s: isError=%v code=%v, want %s", id, r["isError"], sc["code"], code)
		}
		if strings.Contains(sc["message"].(string), "hunter2") {
			t.Errorf("id %s: error message not redacted", id)
		}
	}
}

func TestDescribeDispatchesToTheToolsDescribe(t *testing.T) {
	got := run(t, testServer(),
		`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"t.act","input":{"ssid":"Cafe"}}}}`,
		`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"t.echo","input":{}}}}`,
		`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"jarvis.describe","arguments":{"tool":"nope","input":{}}}}`,
	)
	sc := result(t, got["7"])["structuredContent"].(map[string]any)
	if sc["title"] != "Connect to Cafe" || sc["source"] != "network" {
		t.Fatalf("describe = %v", sc)
	}
	for _, id := range []string{"8", "9"} {
		if result(t, got[id])["structuredContent"].(map[string]any)["code"] != "invalid" {
			t.Errorf("id %s: want invalid", id)
		}
	}
}

func TestProtocolErrors(t *testing.T) {
	got := run(t, testServer(),
		`not json`,
		`{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"no.such.tool","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":11,"method":"resources/list"}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":12,"method":"ping"}`,
	)
	if got["null"]["error"].(map[string]any)["code"] != -32700.0 {
		t.Error("parse error not reported")
	}
	if got["10"]["error"].(map[string]any)["code"] != -32602.0 {
		t.Error("unknown tool must be -32602")
	}
	if got["11"]["error"].(map[string]any)["code"] != -32601.0 {
		t.Error("unknown method must be -32601")
	}
	if len(got) != 4 {
		t.Errorf("a notification must not be answered; got %d responses", len(got))
	}
}

func TestCancelledCallGetsNoResponseAndSeesContextDone(t *testing.T) {
	got := run(t, testServer(),
		`{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"t.block","arguments":{}}}`,
		`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":13,"reason":"user pressed stop"}}`,
	)
	if _, ok := got["13"]; ok {
		t.Fatal("cancelled request was answered")
	}
}

func TestValidateRejectsBadToolLists(t *testing.T) {
	ok := func(context.Context, json.RawMessage) (any, error) { return nil, nil }
	cases := map[string][]Tool{
		"duplicate":       {{Name: "a", Risk: RiskSafe, InputSchema: EmptySchema, Call: ok}, {Name: "a", Risk: RiskSafe, InputSchema: EmptySchema, Call: ok}},
		"reserved name":   {{Name: DescribeTool, Risk: RiskSafe, InputSchema: EmptySchema, Call: ok}},
		"bad schema":      {{Name: "a", Risk: RiskSafe, InputSchema: `{"type":"string"}`, Call: ok}},
		"confirm no desc": {{Name: "a", Risk: RiskConfirm, InputSchema: EmptySchema, Call: ok}},
		"unknown risk":    {{Name: "a", Risk: "yolo", InputSchema: EmptySchema, Call: ok}},
	}
	for name, tools := range cases {
		if err := (&Server{Tools: tools}).Validate(); err == nil {
			t.Errorf("%s: Validate passed", name)
		}
	}
}
