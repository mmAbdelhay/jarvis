package modelfetch

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
	"github.com/mmAbdelhay/jarvis/os/go/internal/modelstate"
	"github.com/mmAbdelhay/jarvis/os/go/internal/ollama"
)

var now = func() time.Time { return time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC) }

// flakyOllama fails the first `fails` pulls with msg, then succeeds.
func flakyOllama(t *testing.T, fails int, msg string) (*ollama.Client, *int) {
	var mu sync.Mutex
	pulls, have := 0, false
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"version":"0.12.3"}`) })
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if have {
			fmt.Fprint(w, `{"models":[{"name":"qwen3:4b"}]}`)
			return
		}
		fmt.Fprint(w, `{"models":[]}`)
	})
	mux.HandleFunc("/api/pull", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		pulls++
		if pulls <= fails {
			fmt.Fprintf(w, `{"error":%q}`+"\n", msg)
			return
		}
		fmt.Fprintln(w, `{"status":"pulling a","digest":"a","total":10,"completed":5}`)
		fmt.Fprintln(w, `{"status":"success"}`)
		have = true
	})
	return &ollama.Client{BaseURL: "http://127.0.0.1:11434", HTTP: &http.Client{Transport: handlerTransport{mux}}, Stall: time.Second}, &pulls
}

// handlerTransport exercises the real HTTP client without binding a socket.
// Localhost listeners are unavailable in the restricted developer sandbox.
type handlerTransport struct{ handler http.Handler }

func (h handlerTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := req.Context().Err(); err != nil {
		return nil, err
	}
	w := httptest.NewRecorder()
	h.handler.ServeHTTP(w, req)
	return w.Result(), nil
}

func pending(t *testing.T) *files.OS {
	f := &files.OS{Root: t.TempDir()}
	if err := modelstate.MarkPending(f, "/"); err != nil {
		t.Fatal(err)
	}
	if err := modelstate.Write(f, "/", modelstate.State{ModelID: "small-4b", OllamaTag: "qwen3:4b", State: modelstate.Pending}, now()); err != nil {
		t.Fatal(err)
	}
	return f
}

func TestRunRetriesThenReady(t *testing.T) {
	f := pending(t)
	client, pulls := flakyOllama(t, 2, "dial tcp: lookup registry.ollama.ai: no such host")
	var waits []time.Duration
	var states []string
	d := Deps{Files: f, Ollama: client, Now: now, Backoff: []time.Duration{time.Minute, 5 * time.Minute},
		Sleep: func(_ context.Context, w time.Duration) error {
			waits = append(waits, w)
			st, _ := modelstate.Read(f, "/")
			states = append(states, st.State+":"+st.Message)
			return nil
		}}
	if err := Run(context.Background(), d); err != nil {
		t.Fatal(err)
	}
	if *pulls != 3 || fmt.Sprint(waits) != "[1m0s 5m0s]" {
		t.Fatalf("pulls %d waits %v", *pulls, waits)
	}
	if states[0] != "pending:Waiting for the internet" {
		t.Fatalf("offline state = %q", states[0])
	}
	st, _ := modelstate.Read(f, "/")
	if st.State != modelstate.Ready || st.Percent != 100 || modelstate.IsPending(f, "/") {
		t.Fatalf("final %+v", st)
	}
}

func TestRunOtherErrorsAreFailedAndRetried(t *testing.T) {
	f := pending(t)
	client, _ := flakyOllama(t, 1, "pull model manifest: 500 Internal Server Error")
	var seen string
	d := Deps{Files: f, Ollama: client, Now: now, Sleep: func(context.Context, time.Duration) error {
		st, _ := modelstate.Read(f, "/")
		seen = st.State
		return nil
	}}
	if err := Run(context.Background(), d); err != nil || seen != modelstate.Failed {
		t.Fatalf("err %v seen %s", err, seen)
	}
}

func TestRunNothingPendingAndServiceDown(t *testing.T) {
	if err := Run(context.Background(), Deps{Files: &files.OS{Root: t.TempDir()}}); err != ErrNothingToDo {
		t.Fatalf("err = %v", err)
	}
	f := pending(t)
	ctx, cancel := context.WithCancel(context.Background())
	var seen string
	d := Deps{Files: f, Ollama: &ollama.Client{BaseURL: "http://127.0.0.1:1"}, Now: now, UpTimeout: 100 * time.Millisecond,
		Sleep: func(context.Context, time.Duration) error {
			st, _ := modelstate.Read(f, "/")
			seen = st.State + ":" + st.Message
			cancel()
			return context.Canceled
		}}
	if err := Run(ctx, d); err != context.Canceled {
		t.Fatalf("err = %v", err)
	}
	if seen != "pending:Waiting for the local model service" || !modelstate.IsPending(f, "/") {
		t.Fatalf("state %q", seen)
	}
}
