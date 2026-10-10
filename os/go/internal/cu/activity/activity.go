// Package activity tells the user's physical input apart from jarvis-cu's
// own virtual input, using only ext-idle-notify (labwc reports activity
// from every device, virtual ones included). See the rules on Detector.
// Spec §2.3: physical input pauses Jarvis within 200 ms.
package activity

import (
	"errors"
	"sync"
	"time"
)

var (
	// ErrPhysical: the seat was busy when Jarvis wanted to act.
	ErrPhysical = errors.New("the user is using the mouse or keyboard")
	// ErrInhibited: the seat never went idle (idle inhibitor or busy user).
	ErrInhibited = errors.New("the seat never went idle")
)

// Clock is time, injectable for tests.
type Clock interface {
	Now() time.Time
	AfterFunc(d time.Duration, f func()) Timer
}

// Timer is a stoppable AfterFunc.
type Timer interface{ Stop() bool }

type realClock struct{}

func (realClock) Now() time.Time                            { return time.Now() }
func (realClock) AfterFunc(d time.Duration, f func()) Timer { return time.AfterFunc(d, f) }

// RealClock is the system clock.
func RealClock() Clock { return realClock{} }

// Config sets the idle-notification timeout the client registered and
// the grace period for our own late "resumed" events.
type Config struct {
	IdleTimeout time.Duration
	Grace       time.Duration
}

// Detector decides when input is physical.
//
//  1. resumed while not injecting and > Grace after our last injection → physical.
//  2. Begin injects only from an idle seat; not idle within IdleTimeout+Grace → physical.
//  3. After End the seat must go idle within IdleTimeout+Grace, else → physical.
//  4. Arm needs idle within max, else ErrInhibited.
type Detector struct {
	clock      Clock
	cfg        Config
	onPhysical func()

	mu        sync.Mutex
	idle      bool
	injecting bool
	lastEnd   time.Time
	settle    Timer
	waiters   []chan struct{}
}

// New makes a detector; onPhysical may be called more than once.
func New(c Clock, cfg Config, onPhysical func()) *Detector {
	return &Detector{clock: c, cfg: cfg, onPhysical: onPhysical}
}

// Event feeds one idle notification event.
func (d *Detector) Event(idled bool) {
	d.mu.Lock()
	fire := false
	if idled {
		d.idle = true
		if d.settle != nil {
			d.settle.Stop()
			d.settle = nil
		}
		for _, w := range d.waiters {
			close(w)
		}
		d.waiters = nil
	} else {
		d.idle = false
		fire = !d.injecting && d.clock.Now().Sub(d.lastEnd) > d.cfg.Grace
	}
	d.mu.Unlock()
	if fire {
		d.onPhysical()
	}
}

// WaitIdle waits up to max for the seat to be idle.
func (d *Detector) WaitIdle(max time.Duration) bool {
	d.mu.Lock()
	if d.idle {
		d.mu.Unlock()
		return true
	}
	ch := make(chan struct{})
	d.waiters = append(d.waiters, ch)
	d.mu.Unlock()
	timeout := make(chan struct{})
	t := d.clock.AfterFunc(max, func() { close(timeout) })
	defer t.Stop()
	select {
	case <-ch:
		return true
	case <-timeout:
		return false
	}
}

// Arm is called when a session begins or resumes.
func (d *Detector) Arm(max time.Duration) error {
	if !d.WaitIdle(max) {
		return ErrInhibited
	}
	return nil
}

// Begin is called right before injecting events.
func (d *Detector) Begin() error {
	if !d.WaitIdle(d.cfg.IdleTimeout + d.cfg.Grace) {
		d.onPhysical()
		return ErrPhysical
	}
	d.mu.Lock()
	d.injecting = true
	if d.settle != nil {
		d.settle.Stop()
		d.settle = nil
	}
	d.mu.Unlock()
	return nil
}

// End is called right after the last injected event.
func (d *Detector) End() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.injecting = false
	d.idle = false // our own events made the seat active
	d.lastEnd = d.clock.Now()
	if d.settle != nil {
		d.settle.Stop()
	}
	d.settle = d.clock.AfterFunc(d.cfg.IdleTimeout+d.cfg.Grace, func() {
		d.mu.Lock()
		still := !d.idle && !d.injecting
		d.settle = nil
		d.mu.Unlock()
		if still {
			d.onPhysical()
		}
	})
}
