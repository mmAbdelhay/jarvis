// Package modelfetch is jarvis-model-fetch (M2 contracts §5, §7): on the
// installed system, while /var/lib/jarvis/model-pending exists, it pulls the
// model named in model-state.json through the local ollama.service, writing
// progress to the state file, and retries with backoff until it succeeds.
package modelfetch

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/modelstate"
	"github.com/mmAbdelhay/jarvis/os/go/internal/ollama"
)

// DefaultBackoff is the wait after each failed attempt; the last repeats.
var DefaultBackoff = []time.Duration{time.Minute, 2 * time.Minute, 5 * time.Minute, 10 * time.Minute, 30 * time.Minute}

// Messages written to the state file (shown by the shell and greeter).
var text = struct{ WaitingService, WaitingNet, Retrying string }{
	WaitingService: "Waiting for the local model service",
	WaitingNet:     "Waiting for the internet",
	Retrying:       "Download failed (%s); trying again in %s",
}

// Deps are the fetcher's side effects.
type Deps struct {
	Files   files.FS
	Ollama  *ollama.Client
	Now     func() time.Time
	Sleep   func(ctx context.Context, d time.Duration) error // nil: real sleep
	Logf    func(format string, a ...any)
	Backoff []time.Duration
	Root    string // "/" installed; tests use "/"
	// UpTimeout is how long one attempt waits for ollama.service; 0 = 2 min.
	UpTimeout time.Duration
}

func (d Deps) sleep(ctx context.Context, t time.Duration) error {
	if d.Sleep != nil {
		return d.Sleep(ctx, t)
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(t):
		return nil
	}
}

func (d Deps) logf(format string, a ...any) {
	if d.Logf != nil {
		d.Logf(format, a...)
	}
}

// ErrNothingToDo means there is no pending marker.
var ErrNothingToDo = errors.New("no model download is pending")

// Run fetches until the model is ready or ctx ends.
func Run(ctx context.Context, d Deps) error {
	root := d.Root
	if root == "" {
		root = "/"
	}
	if !modelstate.IsPending(d.Files, root) {
		return ErrNothingToDo
	}
	st, err := modelstate.Read(d.Files, root)
	if err != nil || st.OllamaTag == "" {
		return fmt.Errorf("model-state.json is unreadable: %v", err)
	}
	backoff := d.Backoff
	if len(backoff) == 0 {
		backoff = DefaultBackoff
	}
	write := func() {
		if err := modelstate.Write(d.Files, root, st, d.Now()); err != nil {
			d.logf("cannot write the state file: %v", err)
		}
	}
	for attempt := 0; ; attempt++ {
		err := once(ctx, d, &st, write)
		if err == nil {
			st.State, st.Percent, st.Message = modelstate.Ready, 100, ""
			write()
			if err := modelstate.ClearPending(d.Files, root); err != nil {
				return err
			}
			d.logf("%s is ready", st.OllamaTag)
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		wait := backoff[min(attempt, len(backoff)-1)]
		switch {
		case errors.Is(err, errServiceDown):
			st.State, st.Message = modelstate.Pending, text.WaitingService
		case offline(err):
			st.State, st.Message = modelstate.Pending, text.WaitingNet
		default:
			st.State, st.Message = modelstate.Failed, fmt.Sprintf(text.Retrying, err, wait)
		}
		write()
		d.logf("attempt %d: %v; next in %s", attempt+1, err, wait)
		if err := d.sleep(ctx, wait); err != nil {
			return err
		}
	}
}

var errServiceDown = errors.New("ollama.service is not answering")

func offline(err error) bool {
	s := err.Error()
	return helperapi.LooksOffline(s) || strings.Contains(s, "no such host") || strings.Contains(s, "network is unreachable") ||
		errors.Is(err, ollama.ErrStalled)
}

func once(ctx context.Context, d Deps, st *modelstate.State, write func()) error {
	up := d.UpTimeout
	if up == 0 {
		up = 2 * time.Minute
	}
	upCtx, cancel := context.WithTimeout(ctx, up)
	err := d.Ollama.WaitUp(upCtx, up/10)
	cancel()
	if err != nil {
		return errServiceDown
	}
	if ok, err := d.Ollama.Has(ctx, st.OllamaTag); err == nil && ok {
		return nil
	}
	last := -1
	err = d.Ollama.Pull(ctx, st.OllamaTag, func(p ollama.Progress) {
		if p.Percent == last {
			return
		}
		last = p.Percent
		st.State, st.Percent, st.Message = modelstate.Downloading, p.Percent, p.Status
		write()
	})
	if err != nil {
		return err
	}
	if ok, err := d.Ollama.Has(ctx, st.OllamaTag); err != nil || !ok {
		return fmt.Errorf("%s is not listed after the pull", st.OllamaTag)
	}
	return nil
}
