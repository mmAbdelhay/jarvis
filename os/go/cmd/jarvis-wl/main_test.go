package main

import (
	"io"
	"os"
	"strings"
	"testing"
)

func TestUsageAndNoSession(t *testing.T) {
	none := func(string) string { return "" }
	for _, args := range [][]string{nil, {"list", "x"}, {"focus"}, {"close", "a", "b"}} {
		if err := run(args, io.Discard, none, os.ReadDir); err == nil || !strings.Contains(err.Error(), "usage") {
			t.Errorf("%v: %v", args, err)
		}
	}
	if err := run([]string{"list"}, io.Discard, none, os.ReadDir); err == nil || !strings.Contains(err.Error(), "XDG_RUNTIME_DIR") {
		t.Errorf("no session: %v", err)
	}
}

func TestUnknownCommandBeforeSessionDiscovery(t *testing.T) {
	err := run([]string{"bogus", "app"}, io.Discard, func(string) string { t.Fatal("read session for invalid command"); return "" }, os.ReadDir)
	if err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("%v", err)
	}
}
