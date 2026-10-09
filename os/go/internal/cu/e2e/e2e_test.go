//go:build linux

// Package e2e drives the real jarvis-cu binary against a real (headless)
// labwc. Run via os/go/ci/cu-headless.sh; skipped elsewhere.
package e2e

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image/png"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

// lockedBuffer permits reading subprocess output while os/exec writes it.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.b.String() }

type client struct {
	t      *testing.T
	c      net.Conn
	mu     sync.Mutex
	next   int
	reply  map[int]chan map[string]any
	events chan proto.Event
}

func connect(t *testing.T, sock string) *client {
	t.Helper()
	var c net.Conn
	var err error
	for i := 0; i < 50; i++ {
		if c, err = net.Dial("unix", sock); err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	cl := &client{t: t, c: c, reply: map[int]chan map[string]any{}, events: make(chan proto.Event, 16)}
	go func() {
		r := bufio.NewReader(c)
		for {
			line, err := r.ReadBytes('\n')
			if err != nil {
				return
			}
			var m map[string]any
			if err := json.Unmarshal(line, &m); err != nil {
				return
			}
			if ev, ok := m["event"].(string); ok {
				cl.events <- proto.Event{Event: ev, Reason: fmt.Sprint(m["reason"])}
				continue
			}
			wireID, ok := m["id"].(float64)
			if !ok {
				return
			}
			id := int(wireID)
			cl.mu.Lock()
			ch := cl.reply[id]
			cl.mu.Unlock()
			if ch != nil {
				ch <- m
			}
		}
	}()
	return cl
}

func (cl *client) do(op string, params map[string]any) (map[string]any, string) {
	cl.t.Helper()
	cl.mu.Lock()
	cl.next++
	id := cl.next
	ch := make(chan map[string]any, 1)
	cl.reply[id] = ch
	cl.mu.Unlock()
	defer func() { cl.mu.Lock(); delete(cl.reply, id); cl.mu.Unlock() }()
	req := map[string]any{"id": id, "op": op}
	for k, v := range params {
		req[k] = v
	}
	b, _ := json.Marshal(req)
	if _, err := cl.c.Write(append(b, '\n')); err != nil {
		cl.t.Fatal(err)
	}
	select {
	case m := <-ch:
		if m["ok"] == true {
			d, _ := m["data"].(map[string]any)
			return d, ""
		}
		return nil, m["error"].(map[string]any)["code"].(string)
	case <-time.After(30 * time.Second):
		cl.t.Fatalf("%s: no reply", op)
		return nil, ""
	}
}

func (cl *client) must(op string, params map[string]any) map[string]any {
	cl.t.Helper()
	d, code := cl.do(op, params)
	if code != "" {
		cl.t.Fatalf("%s: %s", op, code)
	}
	return d
}

func (cl *client) event(within time.Duration) (proto.Event, bool) {
	select {
	case e := <-cl.events:
		return e, true
	case <-time.After(within):
		return proto.Event{}, false
	}
}

func centre(t *testing.T, d map[string]any) [3]uint32 {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(d["pngBase64"].(string))
	if err != nil {
		t.Fatal(err)
	}
	m, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	r, g, bb, _ := m.At(m.Bounds().Dx()/2, m.Bounds().Dy()/2).RGBA()
	return [3]uint32{r >> 8, g >> 8, bb >> 8}
}

func start(t *testing.T, name string, args ...string) (*exec.Cmd, *lockedBuffer) {
	t.Helper()
	var out lockedBuffer
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	return cmd, &out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func observer(t *testing.T) *wlcu.Client {
	t.Helper()
	path, err := wl.SocketPath(os.Getenv, os.ReadDir)
	if err != nil {
		t.Fatal(err)
	}
	c, err := wlcu.Dial(path, wlcu.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func appWindow(t *testing.T, o *wlcu.Client, appID string) wlcu.Toplevel {
	t.Helper()
	var w wlcu.Toplevel
	waitFor(t, appID+" window", func() bool {
		tops, _ := o.Toplevels()
		for _, x := range tops {
			if x.AppID == appID {
				w = x
				return true
			}
		}
		return false
	})
	return w
}

func TestComputerUseAgainstLabwc(t *testing.T) {
	if os.Getenv("JARVIS_CU_INTEGRATION") != "1" {
		t.Skip("run via os/go/ci/cu-headless.sh")
	}
	self, _ := os.Executable()
	tmp := t.TempDir()
	sock := filepath.Join(tmp, "jarvis", "cu.sock")
	fakeLock := filepath.Join(tmp, "fake-lock")
	if err := exec.Command("cp", "/bin/sleep", fakeLock).Run(); err != nil {
		t.Fatal(err)
	}
	start(t, os.Getenv("JARVIS_CU_BIN"), "--socket", sock, "--peer-exe", self, "--peer-script", "", "--lock-exe", fakeLock)
	obs := observer(t)
	_, wevOut := start(t, "stdbuf", "-oL", "wev") // wev block-buffers stdout on a pipe
	appWindow(t, obs, "wev")
	cl := connect(t, sock)
	cl.must("apps", nil) // Contracts §4: app discovery is allowed before begin.
	t.Cleanup(func() { cl.c.Close() })

	t.Run("begin fullscreens the allowed app", func(t *testing.T) {
		cl.t = t
		cl.must("begin", map[string]any{"sessionId": "e2e", "appIds": []string{"wev"}})
		waitFor(t, "fullscreen wev", func() bool { return appWindow(t, obs, "wev").Fullscreen })
	})

	var capW, capH float64
	t.Run("capture shows wev", func(t *testing.T) {
		cl.t = t
		time.Sleep(300 * time.Millisecond) // let wev redraw at the new size
		d := cl.must("capture", map[string]any{"maxEdge": 640})
		capW, capH = d["width"].(float64), d["height"].(float64)
		description := cl.must("describeAt", map[string]any{"x": capW / 2, "y": capH / 2})
		if role, ok := description["role"].(string); !ok || role == "" {
			t.Fatal("describeAt missing role")
		}
		if capW > 640 || centre(t, d) == [3]uint32{0, 0, 0} {
			t.Fatalf("%vx%v centre %v", capW, capH, centre(t, d))
		}
	})

	t.Run("click lands in wev", func(t *testing.T) {
		cl.t = t
		cl.must("click", map[string]any{"x": capW / 2, "y": capH / 2})
		t.Cleanup(func() {
			if t.Failed() {
				t.Logf("wev output:\n%s", wevOut.String())
			}
		})
		waitFor(t, "button event", func() bool { return strings.Contains(wevOut.String(), "button: 272") })
	})

	t.Run("type Arabic and a combo", func(t *testing.T) {
		cl.t = t
		time.Sleep(300 * time.Millisecond)
		cl.must("type", map[string]any{"text": "مرحبًا"})
		waitFor(t, "utf8 Arabic", func() bool { return strings.Contains(wevOut.String(), "utf8: 'م'") })
		cl.must("key", map[string]any{"combo": "ctrl+s"})
		waitFor(t, "sym s", func() bool { return strings.Contains(wevOut.String(), "sym: s ") })
	})

	t.Run("reserved combo and outside point refused", func(t *testing.T) {
		cl.t = t
		if _, code := cl.do("key", map[string]any{"combo": "super+l"}); code != "excluded" {
			t.Fatal(code)
		}
		if _, code := cl.do("click", map[string]any{"x": capW + 1, "y": 1}); code != "outside" {
			t.Fatal(code)
		}
	})

	t.Run("physical mouse pauses within 200 ms", func(t *testing.T) {
		cl.t = t
		time.Sleep(500 * time.Millisecond) // seat idle again
		tops, _ := obs.Outputs()
		if len(tops) == 0 {
			t.Fatal("no outputs")
		}
		p, err := obs.NewPointer(tops[0].Name) // a second device = the user's mouse
		if err != nil {
			t.Fatal(err)
		}
		sent := time.Now()
		if err := p.MoveTo(10, 10, tops[0].Width, tops[0].Height); err != nil {
			t.Fatal(err)
		}
		ev, ok := cl.event(time.Second)
		if !ok || ev.Reason != "physical-input" || time.Since(sent) > 200*time.Millisecond {
			t.Fatalf("event %+v ok=%v after %v", ev, ok, time.Since(sent))
		}
		if _, code := cl.do("click", map[string]any{"x": 1, "y": 1}); code != "paused" {
			t.Fatal(code)
		}
		time.Sleep(300 * time.Millisecond)
		cl.must("begin", map[string]any{"sessionId": "e2e", "appIds": []string{"wev"}}) // resume
		cl.must("capture", map[string]any{"maxEdge": 640})
	})

	t.Run("terminal focus blanks and pauses", func(t *testing.T) {
		cl.t = t
		start(t, "foot")
		appWindow(t, obs, "foot")
		ev, ok := cl.event(2 * time.Second)
		if !ok || ev.Reason != "excluded-focus" {
			t.Fatalf("%+v %v", ev, ok)
		}
		obs.Activate(appWindow(t, obs, "wev").ID)
		time.Sleep(300 * time.Millisecond)
		cl.must("begin", map[string]any{"sessionId": "e2e", "appIds": []string{"wev"}})
		d := cl.must("capture", map[string]any{"maxEdge": 640})
		if centre(t, d) == [3]uint32{0, 0, 0} {
			t.Fatal("wev focused again but capture blank")
		}
		obs.Activate(appWindow(t, obs, "foot").ID)
		time.Sleep(300 * time.Millisecond)
		cl.event(time.Second) // excluded-focus again
	})

	t.Run("password field refuses all input", func(t *testing.T) {
		cl.t = t
		cl.must("end", nil)
		start(t, "zenity", "--password")
		var zid string
		waitFor(t, "zenity", func() bool {
			tops, _ := obs.Toplevels()
			for _, x := range tops {
				if strings.Contains(strings.ToLower(x.AppID), "zenity") {
					zid = x.AppID
					return true
				}
			}
			return false
		})
		time.Sleep(time.Second) // AT-SPI focus event
		cl.must("begin", map[string]any{"sessionId": "pw", "appIds": []string{zid}})
		t.Cleanup(func() { cl.t = t; cl.do("end", nil) }) // a failed assertion must not strand the session for later subtests
		cl.must("capture", nil)
		if _, code := cl.do("type", map[string]any{"text": "secret"}); code != "excluded" {
			t.Fatalf("typing into a password field: %q", code)
		}
		for _, op := range []string{"click", "key", "scroll", "drag"} {
			params := map[string]any{"x": 1, "y": 1, "combo": "ctrl+s", "dx": 1, "dy": 1, "x1": 1, "y1": 1, "x2": 2, "y2": 2}
			if _, code := cl.do(op, params); code != "excluded" {
				t.Fatalf("%s into password field: %q", op, code)
			}
		}
		cl.must("end", nil)
	})

	t.Run("lock pauses and ends", func(t *testing.T) {
		cl.t = t
		cl.must("begin", map[string]any{"sessionId": "lock", "appIds": []string{"wev"}})
		lock, _ := start(t, fakeLock, "30")
		ev, ok := cl.event(time.Second)
		if !ok || ev.Reason != "locked" {
			t.Fatalf("%+v %v", ev, ok)
		}
		time.Sleep(200 * time.Millisecond)
		if _, code := cl.do("capture", nil); code != "no-session" {
			t.Fatalf("session survived the lock: %q", code)
		}
		lock.Process.Kill()
	})

	t.Run("disconnect restores fullscreen", func(t *testing.T) {
		cl.t = t
		time.Sleep(200 * time.Millisecond)
		cl.must("begin", map[string]any{"sessionId": "bye", "appIds": []string{"wev"}})
		waitFor(t, "fullscreen", func() bool { return appWindow(t, obs, "wev").Fullscreen })
		cl.c.Close()
		waitFor(t, "unfullscreen", func() bool { return !appWindow(t, obs, "wev").Fullscreen })
	})
}
