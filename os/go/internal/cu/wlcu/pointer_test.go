package wlcu

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func tail(f *fake, n int) []string {
	l := f.logged()
	if len(l) < n {
		return l
	}
	return l[len(l)-n:]
}

func TestPointerMoveClickScroll(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.NewPointer("HEADLESS-1")
	if err != nil {
		t.Fatal(err)
	}
	if f.count("pointer on HEADLESS-1") != 1 {
		t.Fatal(f.logged())
	}
	if err := p.MoveTo(5, 3, 8, 4); err != nil {
		t.Fatal(err)
	}
	if err := p.Button(ButtonLeft, true); err != nil {
		t.Fatal(err)
	}
	if err := p.Button(ButtonLeft, false); err != nil {
		t.Fatal(err)
	}
	if err := p.Scroll(-2, 3); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"abs 5 3 8 4", "frame",
		"button 0x110 1", "frame",
		"button 0x110 0", "frame",
		"axis-source 0", "discrete 0 45 3", "discrete 1 -30 -2", "frame",
	}
	if got := tail(f, len(want)); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestPointerRefusesPointsOutsideTheBox(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.NewPointer("HEADLESS-1")
	if err != nil {
		t.Fatal(err)
	}
	for _, pt := range [][4]int{{-1, 0, 8, 4}, {8, 0, 8, 4}, {0, 4, 8, 4}, {0, 0, 0, 4}} {
		if err := p.MoveTo(pt[0], pt[1], pt[2], pt[3]); err == nil {
			t.Fatalf("%v accepted", pt)
		}
	}
	if f.count("abs") != 0 {
		t.Fatal("a refused point reached the compositor")
	}
	if _, err := c.NewPointer("nope"); err == nil {
		t.Fatal("unknown output accepted")
	}
}

func TestWatchIdle(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan bool, 4)
	stop, err := c.WatchIdle(50*time.Millisecond, func(idled bool) { got <- idled })
	if err != nil {
		t.Fatal(err)
	}
	if f.count("idle 50ms") != 1 {
		t.Fatal(f.logged())
	}
	f.idle(true)
	f.idle(false)
	for _, want := range []bool{true, false} {
		select {
		case v := <-got:
			if v != want {
				t.Fatalf("got %v want %v", v, want)
			}
		case <-time.After(time.Second):
			t.Fatal("no idle event")
		}
	}
	stop()
	if _, err := c.Toplevels(); err != nil { // round trip
		t.Fatal(err)
	}
	if f.count("idle destroy") != 1 {
		t.Fatal("stop must destroy the notification")
	}
}

func TestPointerClose(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	p, err := c.NewPointer("HEADLESS-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Toplevels(); err != nil {
		t.Fatal(err)
	}
	if f.count("pointer destroy") != 1 {
		t.Fatal(f.logged())
	}
}

func TestWatchIdleStopIsIdempotentAndSuppressesEvents(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan bool, 4)
	stop, err := c.WatchIdle(time.Nanosecond, func(v bool) { got <- v })
	if err != nil {
		t.Fatal(err)
	}
	if f.count("idle 1ms") != 1 {
		t.Fatal(f.logged())
	}
	stop()
	stop()
	f.idle(true)
	if _, err := c.Toplevels(); err != nil {
		t.Fatal(err)
	}
	if f.count("idle destroy") != 1 {
		t.Fatal(f.logged())
	}
	select {
	case <-got:
		t.Fatal("callback after stop")
	default:
	}
}

func TestPointerRefusesRotatedOutput(t *testing.T) {
	f := newFake()
	f.outputs[0].transform = 1
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.NewPointer("HEADLESS-1"); !errors.Is(err, ErrRotated) {
		t.Fatalf("want ErrRotated, got %v", err)
	}
	if f.count("pointer on") != 0 {
		t.Fatal("rotated output reached the compositor")
	}
}
