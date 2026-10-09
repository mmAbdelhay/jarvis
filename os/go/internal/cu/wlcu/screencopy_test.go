package wlcu

import (
	"errors"
	"fmt"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/img"
)

func TestCaptureCopiesPixelsAndWipesShm(t *testing.T) {
	f := newFake()
	f.yInvert = true
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	fr, err := c.Capture("HEADLESS-1")
	if err != nil {
		t.Fatal(err)
	}
	if fr.Width != 8 || fr.Height != 4 || fr.Stride != 32 || fr.Format != img.FormatXRGB8888 || !fr.YInvert {
		t.Fatalf("frame %+v", fr)
	}
	if fr.Pix[0] != 0x30 || fr.Pix[1] != 0x20 || fr.Pix[2] != 0x10 {
		t.Fatalf("pixels %v", fr.Pix[:4])
	}
	f.mu.Lock()
	for fd, mem := range f.fdMem {
		for _, b := range mem {
			if b != 0 {
				f.mu.Unlock()
				t.Fatalf("shm fd %d not wiped", fd)
			}
		}
	}
	f.mu.Unlock()
	for _, want := range []string{"pool destroy", "buffer destroy", "frame destroy"} {
		if f.count(want) != 1 {
			t.Fatalf("%q missing from %v", want, f.logged())
		}
	}
}

func TestCaptureOnScreencopyV1(t *testing.T) {
	f := newFake()
	for i := range f.globals {
		if f.globals[i].iface == IfScreencopy {
			f.globals[i].version = 1
		}
	}
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Capture("HEADLESS-1"); err != nil {
		t.Fatalf("v1 has no buffer_done; the first buffer event must do: %v", err)
	}
}

func TestCaptureFailures(t *testing.T) {
	f := newFake()
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Capture("HDMI-9"); !errors.Is(err, ErrNoOutput) {
		t.Fatalf("unknown output: %v", err)
	}
	f.mu.Lock()
	f.failCopy = true
	f.mu.Unlock()
	if _, err := c.Capture("HEADLESS-1"); err == nil {
		t.Fatal("failed copy accepted")
	}

	g := newFake()
	g.outputs[0].transform = 1
	c2, err := startFake(t, g, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c2.Capture("HEADLESS-1"); !errors.Is(err, ErrRotated) {
		t.Fatalf("rotated: %v", err)
	}

	h := newFake()
	h.format = 0x3231564e // NV12: not readable
	c3, err := startFake(t, h, nil)
	if err != nil {
		t.Fatal(err)
	}
	var ue *UnsupportedError
	if _, err := c3.Capture("HEADLESS-1"); !errors.As(err, &ue) {
		t.Fatalf("odd format: %v", err)
	}
}

func TestCaptureRejectsInvalidDimensions(t *testing.T) {
	for _, size := range [][2]int{{0, 4}, {8, 0}, {16385, 4}, {8, 16385}} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			f := newFake()
			f.outputs[0].w, f.outputs[0].h = size[0], size[1]
			c, err := startFake(t, f, nil)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := c.Capture("HEADLESS-1"); err == nil {
				t.Fatal("invalid dimensions accepted")
			}
			if len(f.fdMem) != 0 {
				t.Fatal("invalid buffer allocated")
			}
			if f.count("frame destroy") != 1 {
				t.Fatal("frame leaked")
			}
		})
	}
}

func TestCaptureCopyFailureCleansUp(t *testing.T) {
	f := newFake()
	f.failCopy = true
	c, err := startFake(t, f, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Capture("HEADLESS-1"); err == nil {
		t.Fatal("copy failure accepted")
	}
	for _, want := range []string{"pool destroy", "buffer destroy", "frame destroy"} {
		if f.count(want) != 1 {
			t.Fatalf("missing cleanup: %s", want)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, mem := range f.fdMem {
		for _, b := range mem {
			if b != 0 {
				t.Fatal("shared memory not wiped")
			}
		}
	}
}
