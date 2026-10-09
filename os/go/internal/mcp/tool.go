// Package mcp is a minimal MCP server over stdio (newline-delimited JSON-RPC
// 2.0, protocol 2025-06-18) that implements exactly what contracts §1 needs:
// initialize, ping, tools/list, tools/call, notifications/cancelled, the
// _meta.jarvis block on every tool, the hidden jarvis.describe tool, typed
// errors, and redaction of every string that leaves the process.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// ProtocolVersion is the only MCP revision these servers speak.
const ProtocolVersion = "2025-06-18"

// DescribeTool is the hidden tool jarvisd calls to build card items.
const DescribeTool = "jarvis.describe"

// Risk is a tool's risk class (contracts §1 _meta.jarvis.risk).
type Risk string

const (
	RiskSafe     Risk = "safe"
	RiskConfirm  Risk = "confirm"
	RiskPassword Risk = "password"
)

// Source is where a card item's action comes from (contracts §1 jarvis.describe).
type Source string

const (
	SourceDebian  Source = "debian"
	SourceFlathub Source = "flathub"
	SourceSystem  Source = "system"
	SourceNetwork Source = "network"
)

// Code is a typed tool error code (contracts §1 Errors).
type Code string

const (
	CodeOffline    Code = "offline"
	CodeNotFound   Code = "not_found"
	CodeInvalid    Code = "invalid"
	CodeDenied     Code = "denied"
	CodeNotAllowed Code = "not_allowed"
	CodeFailed     Code = "failed"
	// CodeUnsupported: this computer cannot do it (contracts §7 items 9, 15).
	CodeUnsupported Code = "unsupported"
)

// ToolError is returned by a handler to produce an isError result.
type ToolError struct {
	Code    Code   `json:"code"`
	Message string `json:"message"`
}

func (e *ToolError) Error() string { return string(e.Code) + ": " + e.Message }

// Errorf builds a ToolError.
func Errorf(code Code, format string, a ...any) *ToolError {
	return &ToolError{Code: code, Message: fmt.Sprintf(format, a...)}
}

// AsToolError converts any error into a ToolError; untyped errors are "failed".
func AsToolError(err error) *ToolError {
	var te *ToolError
	if errors.As(err, &te) {
		return te
	}
	return &ToolError{Code: CodeFailed, Message: err.Error()}
}

// Description is jarvis.describe's structuredContent.
type Description struct {
	Title  string `json:"title"`
	Detail string `json:"detail"`
	Source Source `json:"source"`
}

// Tool is one MCP tool plus its Jarvis metadata.
type Tool struct {
	Name        string
	Description string
	InputSchema string // a JSON Schema object, as JSON text
	Risk        Risk
	Hidden      bool
	Secrets     []string
	// Batch names an array input property whose elements jarvisd shows as
	// separate card items (contracts §6.1), describing each with
	// {<Batch>: [element]} and calling the tool once with the ticked ones.
	Batch string
	// Call runs the tool. The returned value is marshalled to a JSON object.
	Call func(ctx context.Context, args json.RawMessage) (any, error)
	// Describe is required for confirm/password tools; it must be pure.
	Describe func(ctx context.Context, args json.RawMessage) (Description, error)
}

// DecodeArgs decodes tool arguments into dst, refusing unknown fields
// (conventions: parse field by field, never spread input). Missing or null
// arguments decode as {}.
func DecodeArgs(raw json.RawMessage, dst any) error {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		raw = []byte("{}")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return Errorf(CodeInvalid, "bad arguments: %v", err)
	}
	if dec.More() {
		return Errorf(CodeInvalid, "bad arguments: trailing data")
	}
	return nil
}

// EmptySchema is the input schema of a tool that takes no arguments.
const EmptySchema = `{"type":"object","properties":{},"additionalProperties":false}`

const describeSchema = `{"type":"object","properties":{"tool":{"type":"string","minLength":1},"input":{"type":"object"},"lang":{"type":"string","enum":["en","ar"]}},"required":["tool","input"],"additionalProperties":false}`
