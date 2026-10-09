package activity

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	at      time.Time
	f       func()
	stopped bool
	c       *fakeClock
}

func (t *fakeTimer) Stop() bool {
	t.c.mu.Lock()
	defer t.c.mu.Unlock()
	was := !t.stopped
	t.stopped = true
	return was
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) AfterFunc(d time.Duration, f func()) Timer {
	c.mu.Lock()
	defer c.mu.Unlock()
	t := &fakeTimer{at: c.now.Add(d), f: f, c: c}
	c.timers = append(c.timers, t)
	return t
}

func (c *fakeClock) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, t := range c.timers {
		if !t.stopped {
			n++
		}
	}
	return n
}

// waitTimers blocks until n timers are pending (a goroutine registered them).
func (c *fakeClock) waitTimers(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for c.pending() < n {
		if time.Now().After(deadline) {
			t.Fatalf("only %d timers pending", c.pending())
		}
		time.Sleep(time.Millisecond)
	}
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var due []func()
	for _, t := range c.timers {
		if !t.stopped && !t.at.After(c.now) {
			t.stopped = true
			due = append(due, t.f)
		}
	}
	c.mu.Unlock()
	for _, f := range due {
		f()
	}
}

var cfg = Config{IdleTimeout: 50 * time.Millisecond, Grace: 150 * time.Millisecond}

func newDet() (*Detector, *fakeClock, *atomic.Int32) {
	c := &fakeClock{now: time.Unix(1000, 0)}
	var n atomic.Int32
	return New(c, cfg, func() { n.Add(1) }), c, &n
}

func TestResumedWhileNotInjectingIsPhysical(t *testing.T) {
	d, c, n := newDet()
	d.Event(true)
	c.Advance(time.Second)
	d.Event(false)
	if n.Load() != 1 {
		t.Fatalf("fired %d", n.Load())
	}
}

func TestOwnInjectionIsNotPhysical(t *testing.T) {
	d, c, n := newDet()
	d.Event(true)
	if err := d.Begin(); err != nil {
		t.Fatal(err)
	}
	d.Event(false) // our own motion
	d.End()
	c.Advance(100 * time.Millisecond)
	d.Event(false) // a late resumed, inside the grace window
	c.Advance(20 * time.Millisecond)
	d.Event(true)
	c.Advance(time.Second)
	if n.Load() != 0 {
		t.Fatalf("own input counted as physical %d times", n.Load())
	}
}

func TestNoIdleAfterInjectionIsPhysical(t *testing.T) {
	d, c, n := newDet()
	d.Event(true)
	if err := d.Begin(); err != nil {
		t.Fatal(err)
	}
	d.End()
	c.Advance(cfg.IdleTimeout + cfg.Grace)
	if n.Load() != 1 {
		t.Fatalf("continuous movement not detected (%d)", n.Load())
	}
}

func TestBeginRefusesWhileSomeoneIsActive(t *testing.T) {
	d, c, n := newDet()
	res := make(chan error, 1)
	go func() { res <- d.Begin() }()
	c.waitTimers(t, 1)
	c.Advance(cfg.IdleTimeout + cfg.Grace)
	if err := <-res; !errors.Is(err, ErrPhysical) {
		t.Fatalf("got %v", err)
	}
	if n.Load() != 1 {
		t.Fatal("refusal must also pause")
	}
}

func TestBeginWaitsForOwnInputToSettle(t *testing.T) {
	d, c, n := newDet()
	d.Event(true)
	d.Begin()
	d.End()
	res := make(chan error, 1)
	go func() { res <- d.Begin() }()
	c.waitTimers(t, 2) // settle timer + wait timer
	c.Advance(cfg.IdleTimeout)
	d.Event(true)
	if err := <-res; err != nil {
		t.Fatal(err)
	}
	if n.Load() != 0 {
		t.Fatal("paused although the seat went idle")
	}
}

func TestArmFailsWhenNeverIdle(t *testing.T) {
	d, c, _ := newDet()
	res := make(chan error, 1)
	go func() { res <- d.Arm(time.Second) }()
	c.waitTimers(t, 1)
	c.Advance(time.Second)
	if err := <-res; !errors.Is(err, ErrInhibited) {
		t.Fatalf("got %v", err)
	}
	go func() { res <- d.Arm(time.Second) }()
	c.waitTimers(t, 1)
	d.Event(true)
	if err := <-res; err != nil {
		t.Fatal(err)
	}
}
