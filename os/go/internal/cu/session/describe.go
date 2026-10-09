package session

import (
	"context"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

const describeTimeout = 2 * time.Second

// Apps lists the running apps (appId and name only, never titles or
// rectangles). It works without a session so the model can choose apps
// before begin (contracts §4.2).
func (m *Manager) Apps() ([]proto.App, error) {
	m.opMu.Lock()
	defer m.opMu.Unlock()
	tops, err := m.d.Desktop.Toplevels()
	if err != nil {
		return nil, proto.Errorf(proto.CodeFailed, "could not read the windows: %v", err)
	}
	ids := make([]string, 0, len(tops))
	for _, t := range tops {
		ids = append(ids, t.AppID)
	}
	return m.d.Apps().RunningApps(ids), nil
}

// DescribeAt names the accessible under a capture-space point so V can
// build consequential-action cards from AT-SPI rather than from the model's
// words (contracts §4.2). No session or a paused one is an error; any other
// failure (gate, bounds, AT-SPI) answers role "unknown".
func (m *Manager) DescribeAt(p proto.DescribeAt) (*proto.DescribeAtResult, error) {
	unknown := &proto.DescribeAtResult{Role: "unknown"}
	m.opMu.Lock()
	defer m.opMu.Unlock()
	if err := m.gateSession(); err != nil {
		return nil, err
	}
	xy, err := coords([]string{"x", "y"}, []*float64{p.X, p.Y})
	if err != nil {
		return nil, err
	}
	sh, err := m.gateInput(false)
	if err != nil || m.d.DescribeAt == nil {
		return unknown, nil
	}
	ox, oy, err := sh.toOutput(xy[0], xy[1])
	if err != nil {
		return unknown, nil
	}
	v, err := m.snapshot()
	if err != nil || v.base == nil || v.base.Title == "" {
		return unknown, nil
	}
	// The base window is fullscreen on the captured output, so output
	// pixels are window pixels (Ruling U-1).
	ctx, cancel := context.WithTimeout(context.Background(), describeTimeout)
	defer cancel()
	role, name := m.d.DescribeAt(ctx, v.base.Title, ox, oy)
	if role == "" {
		return unknown, nil
	}
	return &proto.DescribeAtResult{Role: role, Name: name}, nil
}
