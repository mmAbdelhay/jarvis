package proto

import (
	"encoding/json"
	"errors"
	"math"
	"testing"
)

func TestResponseShapes(t *testing.T) {
	ok := Response(json.RawMessage(`7`), map[string]int{"n": 1}, nil)
	if string(ok) != `{"id":7,"ok":true,"data":{"n":1}}`+"\n" {
		t.Fatalf("ok: %s", ok)
	}
	nul := Response(json.RawMessage(`"a"`), nil, nil)
	if string(nul) != `{"id":"a","ok":true,"data":null}`+"\n" {
		t.Fatalf("null data: %s", nul)
	}
	bad := Response(json.RawMessage(`"b"`), nil, Errorf(CodeOutside, "point %d,%d", 1, 2))
	if string(bad) != `{"id":"b","ok":false,"error":{"code":"outside","message":"point 1,2"}}`+"\n" {
		t.Fatalf("error: %s", bad)
	}
	plain := Response(nil, nil, errors.New("boom"))
	if string(plain) != `{"id":null,"ok":false,"error":{"code":"failed","message":"boom"}}`+"\n" {
		t.Fatalf("plain error: %s", plain)
	}
}

func TestAsErrorKeepsWrappedCode(t *testing.T) {
	err := errors.Join(errors.New("context"), Errorf(CodePaused, "paused"))
	if AsError(err).Code != CodePaused {
		t.Fatalf("got %+v", AsError(err))
	}
}

func TestCoord(t *testing.T) {
	v := 12.5
	if got, err := Coord("x", &v); err != nil || got != 12.5 {
		t.Fatalf("%v %v", got, err)
	}
	if _, err := Coord("x", nil); AsError(err).Code != CodeFailed {
		t.Fatal("missing coordinate must fail")
	}
	nan := math.NaN()
	if _, err := Coord("y", &nan); err == nil {
		t.Fatal("NaN must fail")
	}
	inf := math.Inf(1)
	if _, err := Coord("y", &inf); err == nil {
		t.Fatal("Inf must fail")
	}
}

func TestParamsDecodeFromFlatRequest(t *testing.T) {
	line := []byte(`{"id":1,"op":"click","x":10,"y":20.5,"button":"right","double":true}`)
	var env Envelope
	var c Click
	if err := json.Unmarshal(line, &env); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(line, &c); err != nil {
		t.Fatal(err)
	}
	if env.Op != "click" || string(env.ID) != "1" || *c.X != 10 || *c.Y != 20.5 || c.Button != "right" || !c.Double {
		t.Fatalf("%+v %+v", env, c)
	}
}

func TestSection4Types(t *testing.T) {
	var point DescribeAt
	if err := json.Unmarshal([]byte(`{"id":2,"op":"describeAt","x":10,"y":20.5}`), &point); err != nil {
		t.Fatal(err)
	}
	if point.X == nil || point.Y == nil || *point.X != 10 || *point.Y != 20.5 {
		t.Fatalf("point: %+v", point)
	}
	for _, tc := range []struct {
		data any
		want string
	}{
		{[]App{{AppID: "editor", Name: "Editor"}}, `{"id":1,"ok":true,"data":[{"appId":"editor","name":"Editor"}]}` + "\n"},
		{DescribeAtResult{Role: "unknown"}, `{"id":1,"ok":true,"data":{"role":"unknown"}}` + "\n"},
		{DescribeAtResult{Role: "button", Name: "Save"}, `{"id":1,"ok":true,"data":{"role":"button","name":"Save"}}` + "\n"},
	} {
		if got := string(Response(json.RawMessage(`1`), tc.data, nil)); got != tc.want {
			t.Fatalf("got %s, want %s", got, tc.want)
		}
	}
}

func TestResponseEncodingFailure(t *testing.T) {
	for _, id := range []json.RawMessage{json.RawMessage(`3`), json.RawMessage(`{`)} {
		got := Response(id, math.NaN(), nil)
		var reply struct {
			ID    json.RawMessage
			OK    bool
			Error *Error
		}
		if err := json.Unmarshal(got, &reply); err != nil {
			t.Fatalf("invalid reply %q: %v", got, err)
		}
		if reply.OK || reply.Error == nil || reply.Error.Code != CodeFailed || got[len(got)-1] != '\n' {
			t.Fatalf("reply: %s", got)
		}
		wantID := "3"
		if !json.Valid(id) {
			wantID = "null"
		}
		if string(reply.ID) != wantID {
			t.Fatalf("id: %s", reply.ID)
		}
	}
}
