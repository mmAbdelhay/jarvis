package session

import (
	"context"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
)

func TestHandleDispatch(t *testing.T) {
	h := newHarness(t)
	if data, err := h.m.Handle("capture", []byte(`{"id":1,"op":"capture"}`)); err == nil || data != nil {
		t.Fatalf("capture without session must return (nil, err): %v %v", data, err)
	}
	if _, err := h.m.Handle("begin", []byte(`{"id":1,"op":"begin","sessionId":"s1","appIds":["gimp"]}`)); err != nil {
		t.Fatal(err)
	}
	data, err := h.m.Handle("capture", []byte(`{"id":2,"op":"capture","maxEdge":640}`))
	if err != nil {
		t.Fatal(err)
	}
	if r, ok := data.(*proto.CaptureResult); !ok || r.Width != 640 {
		t.Fatalf("%T %+v", data, data)
	}
	if data, err := h.m.Handle("windows", []byte(`{"id":3,"op":"windows"}`)); err != nil || len(data.([]proto.Window)) != 3 {
		t.Fatalf("%v %v", data, err)
	}
	if _, err := h.m.Handle("click", []byte(`{"id":4,"op":"click","x":10,"y":10,"button":"left"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Handle("type", []byte(`{"id":5,"op":"type","text":"hi"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Handle("key", []byte(`{"id":6,"op":"key","combo":"ctrl+s"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Handle("scroll", []byte(`{"id":7,"op":"scroll","x":1,"y":1,"dx":0,"dy":2}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Handle("drag", []byte(`{"id":8,"op":"drag","x1":1,"y1":1,"x2":2,"y2":2}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Handle("click", []byte(`{"id":9,"op":"click","x":"ten"}`)); code(err) != proto.CodeFailed {
		t.Fatalf("bad JSON types: %v", err)
	}
	if _, err := h.m.Handle("format-disk", []byte(`{"id":10,"op":"format-disk"}`)); code(err) != proto.CodeFailed {
		t.Fatalf("unknown op: %v", err)
	}
	if data, err := h.m.Handle("end", []byte(`{"id":11,"op":"end"}`)); err != nil || data != nil {
		t.Fatal(err)
	}
	if !h.d.has("fullscreen w1 false") {
		t.Fatal("end must restore")
	}
}

func TestDisconnectedEnds(t *testing.T) {
	h := newHarness(t)
	h.begin(t)
	h.m.Disconnected()
	if !h.d.has("fullscreen w1 false") {
		t.Fatal("a vanished jarvisd must end the session")
	}
}

func TestAppsBeforeBegin(t *testing.T) {
	h := newHarness(t)
	data, err := h.m.Handle("apps", []byte(`{"id":1,"op":"apps"}`))
	if err != nil {
		t.Fatal(err)
	}
	apps, ok := data.([]proto.App)
	if !ok || len(apps) == 0 {
		t.Fatalf("%T %v", data, data)
	}
	for _, a := range apps {
		if a.AppID == "" || a.Name == "" {
			t.Fatalf("%+v", a)
		}
	}
}

func TestDescribeAt(t *testing.T) {
	h := newHarness(t)
	var gotTitle string
	var gx, gy int
	h.m.d.DescribeAt = func(_ context.Context, title string, x, y int) (string, string) {
		gotTitle, gx, gy = title, x, y
		return "button", "Save"
	}
	req := []byte(`{"id":1,"op":"describeAt","x":320,"y":180}`)
	if _, err := h.m.Handle("describeAt", req); code(err) != proto.CodeNoSession {
		t.Fatalf("no session: %v", err)
	}
	h.begin(t)
	if _, err := h.m.Capture(proto.Capture{MaxEdge: 1280}); err != nil {
		t.Fatal(err)
	}
	data, err := h.m.Handle("describeAt", req)
	if err != nil {
		t.Fatal(err)
	}
	r := data.(*proto.DescribeAtResult)
	if r.Role != "button" || r.Name != "Save" || gotTitle != "beach.xcf" || gx != 640 || gy != 360 {
		t.Fatalf("%+v %q %d,%d", r, gotTitle, gx, gy)
	}
	// outside the screenshot, bad JSON types, missing coords
	data, err = h.m.Handle("describeAt", []byte(`{"x":5000,"y":1}`))
	if err != nil || data.(*proto.DescribeAtResult).Role != "unknown" {
		t.Fatalf("outside: %v %v", data, err)
	}
	if _, err := h.m.Handle("describeAt", []byte(`{"x":"a"}`)); code(err) != proto.CodeFailed {
		t.Fatalf("bad: %v", err)
	}
	// focus on an excluded window: unknown, hook not called
	gotTitle = ""
	h.d.focus("w2")
	data, err = h.m.Handle("describeAt", req)
	if err != nil || data.(*proto.DescribeAtResult).Role != "unknown" || gotTitle != "" {
		t.Fatalf("gate: %v %v %q", data, err, gotTitle)
	}
	// no hook wired
	h.d.focus("w1")
	h.m.d.DescribeAt = nil
	data, _ = h.m.Handle("describeAt", req)
	if data.(*proto.DescribeAtResult).Role != "unknown" {
		t.Fatal("nil hook must answer unknown")
	}
}

func TestDescribeAtDividesByOutputScale(t *testing.T) {
	h := newHarness(t)
	h.d.outs[0].Scale = 2
	var gx, gy int
	h.m.d.DescribeAt = func(_ context.Context, _ string, x, y int) (string, string) {
		gx, gy = x, y
		return "button", "Save"
	}
	h.begin(t)
	if _, err := h.m.Capture(proto.Capture{MaxEdge: 1280}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.m.Handle("describeAt", []byte(`{"x":320,"y":180}`)); err != nil {
		t.Fatal(err)
	}
	// 320,180 in the screenshot is 640,360 output pixels, 320,180 logical at scale 2.
	if gx != 320 || gy != 180 {
		t.Fatalf("got %d,%d", gx, gy)
	}
}
