package helperapi

import (
	"context"
	"strings"
	"sync"
)

// FakeCall records one call made to Fake.
type FakeCall struct {
	Method string
	Args   []string
}

// Fake is a Helper for tests of jarvis-pkg and jarvis-diag.
type Fake struct {
	mu    sync.Mutex
	Calls []FakeCall
	// Reply decides each call's answer; nil means every call succeeds.
	Reply func(method string, args []string) (Outcome, error)
}

func (f *Fake) call(method string, args []string) (Outcome, error) {
	f.mu.Lock()
	f.Calls = append(f.Calls, FakeCall{Method: method, Args: append([]string(nil), args...)})
	reply := f.Reply
	f.mu.Unlock()
	if reply == nil {
		return Outcome{OK: true}, nil
	}
	return reply(method, args)
}

// Called returns the recorded calls as "Method arg1 arg2" strings.
func (f *Fake) Called() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, c := range f.Calls {
		out = append(out, strings.TrimSpace(c.Method+" "+strings.Join(c.Args, " ")))
	}
	return out
}

func (f *Fake) AptInstall(_ context.Context, names []string) (Outcome, error) {
	return f.call("AptInstall", names)
}
func (f *Fake) AptRemove(_ context.Context, names []string) (Outcome, error) {
	return f.call("AptRemove", names)
}
func (f *Fake) FlatpakInstall(_ context.Context, refs []string) (Outcome, error) {
	return f.call("FlatpakInstall", refs)
}
func (f *Fake) FlatpakRemove(_ context.Context, refs []string) (Outcome, error) {
	return f.call("FlatpakRemove", refs)
}
func (f *Fake) RestartUnit(_ context.Context, name string) (Outcome, error) {
	return f.call("RestartUnit", []string{name})
}
