// Package proto is jarvis-cu's control-socket protocol (Rafiq v1.1
// contracts §1): newline-delimited JSON requests {id, op, ...} answered by
// {id, ok: true, data} or {id, ok: false, error: {code, message}}, plus
// pushed events {event, reason}. Messages are English: the model reads them.
package proto

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

// Error codes (contracts §1).
const (
	CodeOutside     = "outside"
	CodeExcluded    = "excluded"
	CodePaused      = "paused"
	CodeNoSession   = "no-session"
	CodeUnsupported = "unsupported"
	CodeFailed      = "failed"
)

// Pause reasons pushed as {event: "paused", reason}.
const (
	ReasonPhysicalInput = "physical-input"
	ReasonEsc           = "esc"
	ReasonLocked        = "locked"
	ReasonExcludedFocus = "excluded-focus"
)

// Error is a refusal carrying a contract code.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

// Errorf builds an *Error.
func Errorf(code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AsError maps any error to a contract error; unknown errors are "failed".
func AsError(err error) *Error {
	var e *Error
	if errors.As(err, &e) {
		return e
	}
	return &Error{Code: CodeFailed, Message: err.Error()}
}

// Envelope is what the server reads from every request first.
type Envelope struct {
	ID json.RawMessage `json:"id"`
	Op string          `json:"op"`
}

// Begin starts (or resumes) a session.
type Begin struct {
	SessionID string   `json:"sessionId"`
	AppIDs    []string `json:"appIds"`
}

// Capture asks for a screenshot whose longest edge is at most MaxEdge.
type Capture struct {
	MaxEdge int `json:"maxEdge"`
}

// Click is a click in capture space.
type Click struct {
	X      *float64 `json:"x"`
	Y      *float64 `json:"y"`
	Button string   `json:"button"`
	Double bool     `json:"double"`
}

// Type types text.
type Type struct {
	Text *string `json:"text"`
}

// Key presses a combo such as "ctrl+s".
type Key struct {
	Combo string `json:"combo"`
}

// Scroll scrolls dx/dy wheel clicks at a point.
type Scroll struct {
	X  *float64 `json:"x"`
	Y  *float64 `json:"y"`
	DX int      `json:"dx"`
	DY int      `json:"dy"`
}

// Drag drags with the left button from (X1, Y1) to (X2, Y2).
type Drag struct {
	X1 *float64 `json:"x1"`
	Y1 *float64 `json:"y1"`
	X2 *float64 `json:"x2"`
	Y2 *float64 `json:"y2"`
}

// Window is one entry of the windows list. X/Y/W/H are in capture space.
type Window struct {
	WindowID string `json:"windowId"`
	AppID    string `json:"appId"`
	Title    string `json:"title"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
	W        int    `json:"w"`
	H        int    `json:"h"`
	Focused  bool   `json:"focused"`
	Allowed  bool   `json:"allowed"`
}

// CaptureResult is capture's data.
type CaptureResult struct {
	PNGBase64 string   `json:"pngBase64"`
	Width     int      `json:"width"`
	Height    int      `json:"height"`
	Scale     float64  `json:"scale"`
	Windows   []Window `json:"windows"`
}

// Event is a push.
type Event struct {
	Event  string `json:"event"`
	Reason string `json:"reason"`
}

type okReply struct {
	ID   json.RawMessage `json:"id"`
	OK   bool            `json:"ok"`
	Data any             `json:"data"`
}

type errReply struct {
	ID    json.RawMessage `json:"id"`
	OK    bool            `json:"ok"`
	Error *Error          `json:"error"`
}

// Response encodes one reply line.
func Response(id json.RawMessage, data any, err error) []byte {
	if len(id) == 0 || !json.Valid(id) {
		id = json.RawMessage("null")
	}
	var b []byte
	var merr error
	if err != nil {
		b, merr = json.Marshal(errReply{ID: id, OK: false, Error: AsError(err)})
	} else {
		b, merr = json.Marshal(okReply{ID: id, OK: true, Data: data})
	}
	if merr != nil {
		b, _ = json.Marshal(errReply{ID: id, OK: false, Error: &Error{Code: CodeFailed, Message: "could not encode the reply"}})
	}
	return append(b, '\n')
}

// Coord validates a required, finite coordinate.
func Coord(name string, v *float64) (float64, error) {
	if v == nil {
		return 0, Errorf(CodeFailed, "%s is required", name)
	}
	if math.IsNaN(*v) || math.IsInf(*v, 0) {
		return 0, Errorf(CodeFailed, "%s must be a finite number", name)
	}
	return *v, nil
}

// App identifies a running app without exposing window titles or rectangles.
type App struct {
	AppID string `json:"appId"`
	Name  string `json:"name"`
}

// DescribeAt asks for the accessible role and name at a capture-space point.
type DescribeAt struct {
	X *float64 `json:"x"`
	Y *float64 `json:"y"`
}

// DescribeAtResult omits the name when the accessible role is unknown.
type DescribeAtResult struct {
	Role string `json:"role"`
	Name string `json:"name,omitempty"`
}
