package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestParseFlagsDefaults(t *testing.T) {
	o, err := parseFlags(nil, env(map[string]string{"XDG_RUNTIME_DIR": "/run/user/1000"}))
	if err != nil {
		t.Fatal(err)
	}
	if o.socket != "/run/user/1000/jarvis/cu.sock" || o.peerExe != "/usr/lib/jarvis/node/bin/node" ||
		o.peerScript != "/usr/lib/jarvis/daemon/jarvisd.mjs" ||
		strings.Join(o.lockExes, ",") != "/usr/bin/jarvis-lock,/usr/bin/swaylock" {
		t.Fatalf("%+v", o)
	}
	if _, err := parseFlags(nil, env(nil)); err == nil {
		t.Fatal("no XDG_RUNTIME_DIR and no --socket must fail")
	}
	o, err = parseFlags([]string{"--socket", "/tmp/x.sock", "--peer-exe", "/w/cu.test", "--peer-script", "", "--lock-exe", "/tmp/fake-lock"}, env(nil))
	if err != nil || o.socket != "/tmp/x.sock" || o.peerScript != "" || o.lockExes[0] != "/tmp/fake-lock" {
		t.Fatalf("%+v %v", o, err)
	}
}

func TestUnsupportedHandler(t *testing.T) {
	h := unsupportedHandler{why: "this desktop lacks zwlr_virtual_pointer_manager_v1 v2"}
	if _, err := h.Handle("capture", nil); proto.AsError(err).Code != proto.CodeUnsupported ||
		!strings.Contains(err.Error(), "virtual_pointer") {
		t.Fatal(err)
	}
	if _, err := h.Handle("end", nil); err != nil {
		t.Fatal("end always succeeds")
	}
}

func TestDescribeAtWithoutAccessibility(t *testing.T) {
	a := &a11y{last: time.Now()}
	role, name := a.describe(context.Background(), "Allowed window", 10, 20)
	if role != "unknown" || name != "" {
		t.Fatalf("got %q %q", role, name)
	}
}

func TestUnsupportedHandlerAllOps(t *testing.T) {
	h := unsupportedHandler{why: "missing zwlr_screencopy_manager_v1"}
	for _, op := range []string{"apps", "begin", "windows", "capture", "describeAt", "click", "type", "key", "scroll", "drag"} {
		if _, err := h.Handle(op, nil); proto.AsError(err).Code != proto.CodeUnsupported {
			t.Fatalf("%s: %v", op, err)
		}
	}
}
