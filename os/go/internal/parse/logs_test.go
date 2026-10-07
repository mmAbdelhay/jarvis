package parse

import (
	"strings"
	"testing"
	"time"
)

func TestJournal(t *testing.T) {
	got := Journal(fixture(t, "journal.json"))
	if len(got) != 6 {
		t.Fatalf("got %d entries, want 6 (the non-JSON line skipped)", len(got))
	}
	first := got[0]
	if first.Unit != "NetworkManager.service" || first.Priority != 3 || !strings.Contains(first.Message, "Activation: failed") {
		t.Errorf("first = %+v", first)
	}
	if !first.Time.Equal(time.Date(2025, 10, 7, 10, 0, 0, 123456000, time.UTC)) {
		t.Errorf("time = %v", first.Time)
	}
	if got[2].Unit != "kernel" {
		t.Errorf("kernel transport unit = %q", got[2].Unit)
	}
	if got[3].Unit != "pipewire.service" || !strings.HasPrefix(got[3].Message, "mod loaded") || strings.Contains(got[3].Message, "\x00") {
		t.Errorf("byte-array message = %+v", got[3])
	}
	if got[4].Message != "first value" || got[4].Unit != "myapp" {
		t.Errorf("multi-value message = %+v", got[4])
	}
	if got[5].Message != "" || got[5].Priority != 6 {
		t.Errorf("null message/default priority = %+v", got[5])
	}
}

func TestListUnits(t *testing.T) {
	got := ListUnits(fixture(t, "systemctl-list-units-failed.txt"))
	if len(got) != 3 || got[0].Unit != "crashy.service" || got[0].Active != "failed" || got[0].Description != "Demo service that crashes on start" {
		t.Fatalf("got %+v", got)
	}
	if r := ListUnits("● bad.service loaded failed failed Bad\n"); len(r) != 1 || r[0].Unit != "bad.service" {
		t.Fatalf("bullet prefix not stripped: %+v", r)
	}
}

func TestShowAndShowTime(t *testing.T) {
	blocks := Show(fixture(t, "systemctl-show.txt"))
	if len(blocks) != 3 || blocks[1]["Result"] != "service-start-limit-hit" || blocks[2]["LoadState"] != "not-found" {
		t.Fatalf("got %+v", blocks)
	}
	ts, ok := ShowTime(blocks[0]["StateChangeTimestamp"])
	if !ok || !ts.Equal(time.Date(2026, 10, 7, 9, 12, 44, 0, time.UTC)) {
		t.Fatalf("ShowTime = %v %v", ts, ok)
	}
	if _, ok := ShowTime(blocks[2]["StateChangeTimestamp"]); ok {
		t.Fatal("empty timestamp must be not-ok")
	}
}
