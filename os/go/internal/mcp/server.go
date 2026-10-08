package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"io"
	"sync"
)

// maxLine bounds one incoming JSON-RPC message.
const maxLine = 4 << 20

// Server serves a fixed tool list over one stdio connection.
type Server struct {
	Name    string
	Version string
	Tools   []Tool
	// Redact is applied to every string in every result and error message
	// before it is written. nil means no redaction.
	Redact func(string) string
}

type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// Validate checks the tool list once at startup: unique names, valid JSON
// object schemas, a known risk, and a Describe for every gated tool.
func (s *Server) Validate() error {
	seen := map[string]bool{DescribeTool: true}
	for _, t := range s.Tools {
		if seen[t.Name] {
			return fmt.Errorf("mcp: duplicate or reserved tool name %q", t.Name)
		}
		seen[t.Name] = true
		var schema struct {
			Type       string `json:"type"`
			Properties map[string]struct {
				Type string `json:"type"`
			} `json:"properties"`
		}
		if err := json.Unmarshal([]byte(t.InputSchema), &schema); err != nil || schema.Type != "object" {
			return fmt.Errorf("mcp: tool %q: input schema must be a JSON object schema", t.Name)
		}
		if t.Batch != "" && schema.Properties[t.Batch].Type != "array" {
			return fmt.Errorf("mcp: tool %q: batch property %q must be an array input", t.Name, t.Batch)
		}
		switch t.Risk {
		case RiskSafe:
		case RiskConfirm, RiskPassword:
			if t.Describe == nil {
				return fmt.Errorf("mcp: tool %q is %s but has no Describe", t.Name, t.Risk)
			}
		default:
			return fmt.Errorf("mcp: tool %q has unknown risk %q", t.Name, t.Risk)
		}
		if t.Call == nil {
			return fmt.Errorf("mcp: tool %q has no Call", t.Name)
		}
	}
	return nil
}

// Serve reads requests from in and writes responses to out until in ends.
// tools/call requests run concurrently; everything else is answered inline.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	if err := s.Validate(); err != nil {
		return err
	}
	byName := map[string]*Tool{}
	for i := range s.Tools {
		byName[s.Tools[i].Name] = &s.Tools[i]
	}

	var wmu sync.Mutex
	write := func(r rpcResponse) {
		r.JSONRPC = "2.0"
		b, err := json.Marshal(r)
		if err != nil {
			b, _ = json.Marshal(rpcResponse{JSONRPC: "2.0", ID: r.ID, Error: &rpcError{Code: -32603, Message: "internal error"}})
		}
		wmu.Lock()
		defer wmu.Unlock()
		out.Write(append(b, '\n'))
	}

	var (
		wg        sync.WaitGroup
		imu       sync.Mutex
		inflight  = map[string]context.CancelFunc{}
		cancelled = map[string]bool{}
	)

	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 64*1024), maxLine)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var m rpcMsg
		if err := json.Unmarshal(line, &m); err != nil || m.JSONRPC != "2.0" {
			write(rpcResponse{ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "parse error"}})
			continue
		}
		if m.Method == "" {
			continue // a response to something we never send; ignore
		}
		if len(m.ID) == 0 { // notification
			if m.Method == "notifications/cancelled" {
				var p struct {
					RequestID json.RawMessage `json:"requestId"`
				}
				if json.Unmarshal(m.Params, &p) == nil {
					key := string(p.RequestID)
					imu.Lock()
					if cancel, ok := inflight[key]; ok {
						cancelled[key] = true
						cancel()
					}
					imu.Unlock()
				}
			}
			continue
		}
		switch m.Method {
		case "initialize":
			write(rpcResponse{ID: m.ID, Result: map[string]any{
				"protocolVersion": ProtocolVersion,
				"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
				"serverInfo":      map[string]any{"name": s.Name, "version": s.Version},
			}})
		case "ping":
			write(rpcResponse{ID: m.ID, Result: map[string]any{}})
		case "tools/list":
			write(rpcResponse{ID: m.ID, Result: map[string]any{"tools": s.listTools()}})
		case "tools/call":
			var p struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			if err := json.Unmarshal(m.Params, &p); err != nil {
				write(rpcResponse{ID: m.ID, Error: &rpcError{Code: -32602, Message: "invalid params"}})
				continue
			}
			if p.Name != DescribeTool && byName[p.Name] == nil {
				write(rpcResponse{ID: m.ID, Error: &rpcError{Code: -32602, Message: "unknown tool: " + p.Name}})
				continue
			}
			key := string(m.ID)
			cctx, cancel := context.WithCancel(ctx)
			imu.Lock()
			inflight[key] = cancel
			imu.Unlock()
			wg.Add(1)
			go func(id json.RawMessage, name string, args json.RawMessage) {
				defer wg.Done()
				defer cancel()
				res := s.callTool(cctx, byName, name, args)
				imu.Lock()
				skip := cancelled[key]
				delete(inflight, key)
				delete(cancelled, key)
				imu.Unlock()
				if !skip { // MCP: no response for a request the client cancelled
					write(rpcResponse{ID: id, Result: res})
				}
			}(m.ID, p.Name, p.Arguments)
		default:
			write(rpcResponse{ID: m.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + m.Method}})
		}
	}
	// Input ended: jarvisd is gone, so nobody will read an answer. Cancel
	// what is still running (helper calls opt out with WithoutCancel).
	imu.Lock()
	for _, cancel := range inflight {
		cancel()
	}
	imu.Unlock()
	wg.Wait()
	return sc.Err()
}

func (s *Server) listTools() []map[string]any {
	meta := func(risk Risk, hidden bool, secrets []string, batch string) map[string]any {
		if secrets == nil {
			secrets = []string{}
		}
		j := map[string]any{"risk": risk, "hidden": hidden, "secrets": secrets}
		if batch != "" {
			j["batch"] = batch
		}
		return map[string]any{"jarvis": j}
	}
	out := make([]map[string]any, 0, len(s.Tools)+1)
	for _, t := range s.Tools {
		out = append(out, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"inputSchema": json.RawMessage(t.InputSchema),
			"_meta":       meta(t.Risk, t.Hidden, t.Secrets, t.Batch),
		})
	}
	out = append(out, map[string]any{
		"name":        DescribeTool,
		"description": "Describe a pending tool call for a confirm card. Never offered to the model.",
		"inputSchema": json.RawMessage(describeSchema),
		"_meta":       meta(RiskSafe, true, nil, ""),
	})
	return out
}

func (s *Server) callTool(ctx context.Context, byName map[string]*Tool, name string, args json.RawMessage) (result map[string]any) {
	defer func() {
		if r := recover(); r != nil {
			result = s.errorResult(Errorf(CodeFailed, "internal error in %s", name))
		}
	}()
	var (
		v   any
		err error
	)
	if name == DescribeTool {
		v, err = s.describe(ctx, byName, args)
	} else {
		v, err = byName[name].Call(ctx, args)
	}
	if err != nil {
		return s.errorResult(AsToolError(err))
	}
	return s.okResult(v)
}

func (s *Server) describe(ctx context.Context, byName map[string]*Tool, args json.RawMessage) (any, error) {
	var in struct {
		Tool  string          `json:"tool"`
		Input json.RawMessage `json:"input"`
		Lang  string          `json:"lang"`
	}
	if err := DecodeArgs(args, &in); err != nil {
		return nil, err
	}
	lang, ok := i18n.Parse(in.Lang)
	if !ok {
		return nil, Errorf(CodeInvalid, "lang must be \"en\" or \"ar\"")
	}
	t := byName[in.Tool]
	if t == nil || t.Describe == nil {
		return nil, Errorf(CodeInvalid, "no description for tool %q", in.Tool)
	}
	d, err := t.Describe(i18n.WithLang(ctx, lang), in.Input)
	if err != nil {
		return nil, err
	}
	return d, nil
}

func (s *Server) okResult(v any) map[string]any {
	generic, err := s.generic(v)
	if err != nil {
		return s.errorResult(Errorf(CodeFailed, "could not encode result"))
	}
	if _, ok := generic.(map[string]any); !ok {
		return s.errorResult(Errorf(CodeFailed, "result is not an object"))
	}
	text, _ := json.Marshal(generic)
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": string(text)}},
		"structuredContent": generic,
		"isError":           false,
	}
}

func (s *Server) errorResult(te *ToolError) map[string]any {
	msg := te.Message
	if s.Redact != nil {
		msg = s.Redact(msg)
	}
	body := map[string]any{"code": string(te.Code), "message": msg}
	text, _ := json.Marshal(body)
	return map[string]any{
		"content":           []any{map[string]any{"type": "text", "text": string(text)}},
		"structuredContent": body,
		"isError":           true,
	}
}

// generic round-trips v through JSON into map/slice/string/json.Number form
// and redacts every string in it, so no handler can forget to.
func (s *Server) generic(v any) (any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var g any
	if err := dec.Decode(&g); err != nil {
		return nil, err
	}
	if s.Redact != nil {
		g = walkStrings(g, s.Redact)
	}
	return g, nil
}

func walkStrings(v any, f func(string) string) any {
	switch t := v.(type) {
	case string:
		return f(t)
	case []any:
		for i := range t {
			t[i] = walkStrings(t[i], f)
		}
		return t
	case map[string]any:
		for k, x := range t {
			t[k] = walkStrings(x, f)
		}
		return t
	default:
		return v
	}
}
