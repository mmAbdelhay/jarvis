package ollama

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func server(t *testing.T, pull http.HandlerFunc) *Client {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/version", func(w http.ResponseWriter, _ *http.Request) { fmt.Fprint(w, `{"version":"0.12.3"}`) })
	mux.HandleFunc("/api/tags", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"models":[{"name":"qwen3:8b","model":"qwen3:8b"},{"name":"llama3.2:latest","model":"llama3.2:latest"}]}`)
	})
	if pull != nil {
		mux.HandleFunc("/api/pull", pull)
	}
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return &Client{BaseURL: s.URL, Stall: 300 * time.Millisecond}
}

func TestPullReportsOverallPercentAndSuccess(t *testing.T) {
	c := server(t, func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		json.NewDecoder(r.Body).Decode(&in)
		if in["model"] != "qwen3:8b" || in["stream"] != true {
			http.Error(w, `{"error":"bad request"}`, 400)
			return
		}
		for _, l := range []string{
			`{"status":"pulling manifest"}`,
			`{"status":"pulling a","digest":"sha256:a","total":300,"completed":150}`,
			`{"status":"pulling b","digest":"sha256:b","total":100,"completed":100}`,
			`{"status":"pulling a","digest":"sha256:a","total":300,"completed":300}`,
			`{"status":"verifying sha256 digest"}`,
			`{"status":"success"}`,
		} {
			fmt.Fprintln(w, l)
		}
	})
	var got []int
	if err := c.Pull(context.Background(), "qwen3:8b", func(p Progress) { got = append(got, p.Percent) }); err != nil {
		t.Fatal(err)
	}
	want := []int{0, 50, 62, 99, 99, 100}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("percents = %v, want %v", got, want)
	}
}

func TestPullErrors(t *testing.T) {
	c := server(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, `{"status":"pulling manifest"}`)
		fmt.Fprintln(w, `{"error":"pull model manifest: file does not exist"}`)
	})
	if err := c.Pull(context.Background(), "nope:1", nil); err == nil || err.Error() != "ollama pull: pull model manifest: file does not exist" {
		t.Fatalf("err = %v", err)
	}
	c = server(t, func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, `{"status":"pulling manifest"}`)
		w.(http.Flusher).Flush()
		time.Sleep(2 * time.Second) // never says anything again
	})
	if err := c.Pull(context.Background(), "qwen3:8b", nil); !errors.Is(err, ErrStalled) {
		t.Fatalf("stall: err = %v", err)
	}
	c = server(t, func(w http.ResponseWriter, _ *http.Request) { fmt.Fprintln(w, `{"status":"pulling manifest"}`) })
	if err := c.Pull(context.Background(), "qwen3:8b", nil); err == nil {
		t.Fatal("a stream that ends without success is an error")
	}
}

func TestVersionHasAndWaitUp(t *testing.T) {
	c := server(t, nil)
	if v, err := c.Version(context.Background()); err != nil || v != "0.12.3" {
		t.Fatalf("version %q, %v", v, err)
	}
	for tag, want := range map[string]bool{"qwen3:8b": true, "llama3.2": true, "qwen3:32b": false} {
		if got, err := c.Has(context.Background(), tag); err != nil || got != want {
			t.Errorf("Has(%s) = %v, %v", tag, got, err)
		}
	}
	if err := c.WaitUp(context.Background(), 10*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	down := &Client{BaseURL: "http://127.0.0.1:1"}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := down.WaitUp(ctx, 20*time.Millisecond); err == nil {
		t.Fatal("WaitUp on a dead port must fail when ctx ends")
	}
}
