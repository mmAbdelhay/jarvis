package install

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helper"
)

// D-Bus names (contracts §1).
const (
	BusName    = "os.jarvis.Installer1"
	ObjectPath = "/os/jarvis/Installer1"
	Interface  = "os.jarvis.Installer1"
	// ActionRun is the polkit action every method checks.
	ActionRun = "os.jarvis.installer.run"
)

// D-Bus error names. Refused is contracts §1; the others are Plan F's
// (reported as a contract gap): malformed input, a planId the backend did
// not just produce, a second Execute, a Cancel after the first write, a
// caller polkit refused, and a probe that could not run.
const (
	ErrRefused        = "os.jarvis.Installer1.Error.Refused"
	ErrInvalid        = "os.jarvis.Installer1.Error.Invalid"
	ErrUnknownPlan    = "os.jarvis.Installer1.Error.UnknownPlan"
	ErrBusy           = "os.jarvis.Installer1.Error.Busy"
	ErrNotCancellable = "os.jarvis.Installer1.Error.NotCancellable"
	ErrDenied         = "os.jarvis.Installer1.Error.Denied"
	ErrFailed         = "os.jarvis.Installer1.Error.Failed"
)

// BusError is a refused call; the adapter sends it as a D-Bus error.
type BusError struct{ Name, Message string }

func (e *BusError) Error() string { return e.Name + ": " + e.Message }

// Backend is os.jarvis.Installer1 without D-Bus: every decision lives here.
// It keeps the last probe and the last plan; Execute accepts only that
// plan's id, so the UI can never submit commands or a layout of its own.
type Backend struct {
	Auth    helper.Authorizer
	ProbeFn func(context.Context) (ProbeResult, error)
	Deps    Deps // Execute's; Events is set by the D-Bus adapter
	// ExecuteFn runs the install (tests replace it); nil means Execute.
	ExecuteFn func(context.Context, Deps, Planned, Secrets, *Gate)
	NewID     func() string // nil means 128 random bits, hex

	mu      sync.Mutex
	probe   *ProbeResult
	plan    *Planned
	state   string // "", "running", "finished"
	gate    *Gate
	running sync.WaitGroup
}

func (b *Backend) authorize(ctx context.Context, sender string) error {
	if err := b.Auth.Authorize(ctx, sender, ActionRun); err != nil {
		return &BusError{ErrDenied, "not authorized: " + err.Error()}
	}
	return nil
}

func (b *Backend) newID() string {
	if b.NewID != nil {
		return b.NewID()
	}
	var buf [16]byte
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}

// Probe reads the machine and remembers the result for Plan.
func (b *Backend) Probe(ctx context.Context, sender string) (string, error) {
	if err := b.authorize(ctx, sender); err != nil {
		return "", err
	}
	// Probe may mount the Windows partition; never touch a disk Execute owns.
	b.mu.Lock()
	busy := b.state != ""
	b.mu.Unlock()
	if busy {
		return "", &BusError{ErrBusy, "the installation has already started"}
	}
	p, err := b.ProbeFn(ctx)
	if err != nil {
		return "", &BusError{ErrFailed, "could not read the disks: " + err.Error()}
	}
	b.mu.Lock()
	if b.state != "" {
		b.mu.Unlock()
		return "", &BusError{ErrBusy, "the installation has already started"}
	}
	b.probe = &p
	b.mu.Unlock()
	out, _ := json.Marshal(p)
	return string(out), nil
}

// Plan validates the choices against the last probe and returns the
// InstallPlan. It never touches a disk; calling it again replaces the plan.
func (b *Backend) Plan(ctx context.Context, sender, choicesJSON string) (string, error) {
	if err := b.authorize(ctx, sender); err != nil {
		return "", err
	}
	b.mu.Lock()
	busy, probe := b.state != "", b.probe
	b.mu.Unlock()
	if busy {
		return "", &BusError{ErrBusy, "the installation has already started"}
	}
	if probe == nil {
		if _, err := b.Probe(ctx, sender); err != nil {
			return "", err
		}
		b.mu.Lock()
		probe = b.probe
		b.mu.Unlock()
	}
	c, err := DecodeChoices([]byte(choicesJSON))
	if err != nil {
		return "", &BusError{ErrInvalid, err.Error()}
	}
	pl, err := MakePlan(c, *probe, b.newID())
	var r *Refusal
	var inv *InvalidError
	switch {
	case errors.As(err, &r):
		return "", &BusError{ErrRefused, r.Error()}
	case errors.As(err, &inv):
		return "", &BusError{ErrInvalid, inv.Error()}
	case err != nil:
		return "", &BusError{ErrFailed, err.Error()}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state != "" {
		return "", &BusError{ErrBusy, "the installation has already started"}
	}
	b.plan = &pl
	out, _ := json.Marshal(pl.Public)
	return string(out), nil
}

// Execute starts the plan with planID and returns at once; progress and
// the result arrive as signals. It runs at most once per backend process.
func (b *Backend) Execute(ctx context.Context, sender, planID, secretsJSON string) error {
	if err := b.authorize(ctx, sender); err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state != "" {
		return &BusError{ErrBusy, "the installation has already started"}
	}
	if b.plan == nil || planID == "" || planID != b.plan.Public.PlanID {
		return &BusError{ErrUnknownPlan, "this plan is not the one on the Review screen; review again"}
	}
	sec, err := DecodeSecrets([]byte(secretsJSON))
	if err == nil {
		err = checkSecrets(sec, b.plan.Layout.Encrypt)
	}
	if err != nil {
		return &BusError{ErrInvalid, err.Error()}
	}
	run := b.ExecuteFn
	if run == nil {
		run = Execute
	}
	pl := *b.plan
	b.state, b.gate, b.plan = "running", &Gate{}, nil
	gate := b.gate
	b.running.Add(1)
	go func() {
		defer b.running.Done()
		run(context.Background(), b.Deps, pl, sec, gate)
		b.mu.Lock()
		b.state = "finished"
		b.mu.Unlock()
	}()
	return nil
}

// Cancel stops an install that has not written anything yet.
func (b *Backend) Cancel(ctx context.Context, sender string) error {
	if err := b.authorize(ctx, sender); err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state != "running" {
		b.plan = nil
		return nil
	}
	if !b.gate.Cancel() {
		return &BusError{ErrNotCancellable, "the disk is already being changed; the installation cannot be stopped safely"}
	}
	return nil
}

// Busy reports whether an install is running (main waits on SIGTERM).
func (b *Backend) Busy() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.state == "running"
}

// Wait blocks until a started install has finished.
func (b *Backend) Wait() { b.running.Wait() }
