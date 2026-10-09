package session

import (
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
