// Package ollama is the small slice of the Ollama HTTP API the installer
// and jarvis-model-fetch need: is the server up, pull a model with
// progress, and is a model present. Only loopback servers are ever used.
package ollama

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ErrStalled means a pull made no progress for Client.Stall.
var ErrStalled = errors.New("download stalled")

// Client talks to one Ollama server.
type Client struct {
	BaseURL string        // e.g. "http://127.0.0.1:11434"
	HTTP    *http.Client  // nil means a client with no overall timeout (pulls are long)
	Stall   time.Duration // 0 means 2 minutes
}

// Progress is one pull update. Percent covers every layer seen so far.
type Progress struct {
	Status    string
	Completed int64
	Total     int64
	Percent   int
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{}
}

// Version returns the server version; an error means it is not up (yet).
func (c *Client) Version(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/version", nil)
	resp, err := c.http().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var v struct {
		Version string `json:"version"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&v) != nil {
		return "", fmt.Errorf("ollama: unexpected /api/version reply (HTTP %d)", resp.StatusCode)
	}
	return v.Version, nil
}

// WaitUp polls Version until it answers or ctx ends.
func (c *Client) WaitUp(ctx context.Context, every time.Duration) error {
	for {
		if _, err := c.Version(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("ollama did not start: %w", ctx.Err())
		case <-time.After(every):
		}
	}
}

// Has reports whether tag is present (GET /api/tags).
func (c *Client) Has(ctx context.Context, tag string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/tags", nil)
	resp, err := c.http().Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	var v struct {
		Models []struct {
			Name  string `json:"name"`
			Model string `json:"model"`
		} `json:"models"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&v) != nil {
		return false, fmt.Errorf("ollama: unexpected /api/tags reply (HTTP %d)", resp.StatusCode)
	}
	want := withTag(tag)
	for _, m := range v.Models {
		if withTag(m.Name) == want || withTag(m.Model) == want {
			return true, nil
		}
	}
	return false, nil
}

func withTag(s string) string {
	if !strings.Contains(s, ":") {
		return s + ":latest"
	}
	return s
}

// Pull downloads tag, calling progress for every update. It fails with
// ErrStalled when no line arrives for Stall; Ollama resumes partial blobs,
// so a later Pull continues where this one stopped.
func (c *Client) Pull(ctx context.Context, tag string, progress func(Progress)) error {
	stall := c.Stall
	if stall == 0 {
		stall = 2 * time.Minute
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stalled bool
	var mu sync.Mutex
	watchdog := time.AfterFunc(stall, func() {
		mu.Lock()
		stalled = true
		mu.Unlock()
		cancel()
	})
	defer watchdog.Stop()

	body, _ := json.Marshal(map[string]any{"model": tag, "stream": true})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/pull", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http().Do(req)
	if err != nil {
		return c.pullErr(err, &mu, &stalled)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("ollama pull: HTTP %d: %s", resp.StatusCode, apiError(msg))
	}
	layers := map[string][2]int64{}
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		watchdog.Reset(stall)
		var ev struct {
			Status    string `json:"status"`
			Digest    string `json:"digest"`
			Total     int64  `json:"total"`
			Completed int64  `json:"completed"`
			Error     string `json:"error"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		if ev.Error != "" {
			return fmt.Errorf("ollama pull: %s", ev.Error)
		}
		if ev.Digest != "" && ev.Total > 0 {
			layers[ev.Digest] = [2]int64{ev.Completed, ev.Total}
		}
		var done, total int64
		for _, l := range layers {
			done, total = done+l[0], total+l[1]
		}
		p := Progress{Status: ev.Status, Completed: done, Total: total}
		if total > 0 {
			p.Percent = int(done * 100 / total)
		}
		if ev.Status == "success" {
			p.Percent = 100
			if progress != nil {
				progress(p)
			}
			return nil
		}
		if p.Percent > 99 {
			p.Percent = 99 // 100 only once Ollama says success
		}
		if progress != nil {
			progress(p)
		}
	}
	if err := sc.Err(); err != nil {
		return c.pullErr(err, &mu, &stalled)
	}
	if err := c.pullErr(ctx.Err(), &mu, &stalled); err != nil {
		return err
	}
	return errors.New("ollama pull: stream ended before success")
}

func (c *Client) pullErr(err error, mu *sync.Mutex, stalled *bool) error {
	if err == nil {
		return nil
	}
	mu.Lock()
	defer mu.Unlock()
	if *stalled {
		return ErrStalled
	}
	return fmt.Errorf("ollama pull: %w", err)
}

func apiError(b []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil && e.Error != "" {
		return e.Error
	}
	return strings.TrimSpace(string(b))
}
