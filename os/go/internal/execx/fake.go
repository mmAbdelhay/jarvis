package execx

import (
	"context"
	"fmt"
	"strings"
	"sync"
)

// Fake is a Runner for tests. Each expected argv is registered with On; an
// argv nobody registered returns an error, so a test never passes because a
// command it did not expect silently "succeeded".
type Fake struct {
	mu        sync.Mutex
	responses map[string]Result
	errs      map[string]error
	Calls     []Cmd
}

// Key joins a program name and its arguments into a lookup key.
func Key(name string, args ...string) string {
	return strings.Join(append([]string{name}, args...), "\x00")
}

// On registers the Result for one exact argv.
func (f *Fake) On(res Result, name string, args ...string) *Fake {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.responses == nil {
		f.responses = map[string]Result{}
	}
	f.responses[Key(name, args...)] = res
	return f
}

// OnErr registers a start/timeout error for one exact argv.
func (f *Fake) OnErr(err error, name string, args ...string) *Fake {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errs == nil {
		f.errs = map[string]error{}
	}
	f.errs[Key(name, args...)] = err
	return f
}

// Run implements Runner.
func (f *Fake) Run(_ context.Context, c Cmd) (Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Calls = append(f.Calls, c)
	k := Key(c.Name, c.Args...)
	if err, ok := f.errs[k]; ok {
		return Result{ExitCode: -1}, err
	}
	if res, ok := f.responses[k]; ok {
		return res, nil
	}
	return Result{ExitCode: -1}, fmt.Errorf("execx.Fake: unexpected command %q", strings.Join(append([]string{c.Name}, c.Args...), " "))
}

// Ran reports whether exactly this argv was run.
func (f *Fake) Ran(name string, args ...string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	k := Key(name, args...)
	for _, c := range f.Calls {
		if Key(c.Name, c.Args...) == k {
			return true
		}
	}
	return false
}

// CallsTo returns every recorded call to program name, in order.
func (f *Fake) CallsTo(name string) []Cmd {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Cmd
	for _, c := range f.Calls {
		if c.Name == name {
			out = append(out, c)
		}
	}
	return out
}

// OK is a zero-exit Result with stdout.
func OK(stdout string) Result { return Result{Stdout: []byte(stdout)} }

// Exit is a Result with an exit code and stderr.
func Exit(code int, stderr string) Result {
	return Result{ExitCode: code, Stderr: []byte(stderr)}
}
