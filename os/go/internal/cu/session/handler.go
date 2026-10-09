package session

import (
	"encoding/json"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

// Handle decodes one request line for op and runs it (server.Handler).
// Results are returned as untyped nil on error, never a typed nil pointer.
func (m *Manager) Handle(op string, line []byte) (any, error) {
	decode := func(dst any) error {
		if err := json.Unmarshal(line, dst); err != nil {
			return proto.Errorf(proto.CodeFailed, "bad %s request: %v", op, err)
		}
		return nil
	}
	switch op {
	case "begin":
		var p proto.Begin
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, m.Begin(p)
	case "windows":
		ws, err := m.Windows()
		if err != nil {
			return nil, err
		}
		return ws, nil
	case "capture":
		var p proto.Capture
		if err := decode(&p); err != nil {
			return nil, err
		}
		r, err := m.Capture(p)
		if err != nil {
			return nil, err
		}
		return r, nil
	case "click":
		var p proto.Click
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, m.Click(p)
	case "type":
		var p proto.Type
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, m.Type(p)
	case "key":
		var p proto.Key
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, m.Key(p)
	case "scroll":
		var p proto.Scroll
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, m.Scroll(p)
	case "drag":
		var p proto.Drag
		if err := decode(&p); err != nil {
			return nil, err
		}
		return nil, m.Drag(p)
	case "end":
		m.End()
		return nil, nil
	}
	return nil, proto.Errorf(proto.CodeFailed, "unknown op %q", op)
}

// Disconnected ends the session when jarvisd goes away.
func (m *Manager) Disconnected() { m.End() }
