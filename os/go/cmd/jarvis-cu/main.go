// jarvis-cu is Rafiq's computer-use helper (Rafiq v1.1 contracts §1): a
// Wayland client in the user's session that captures the allowed apps'
// windows and injects pointer/keyboard input for jarvisd, refusing
// anything outside the allowed windows and pausing on physical input or
// a lock. Started by labwc autostart via jarvis-cu.service.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/activity"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/guard"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/img"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/policy"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/proto"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/server"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/session"
	"github.com/mmAbdelhay/jarvis/os/go/internal/cu/wlcu"
	"github.com/mmAbdelhay/jarvis/os/go/internal/desktop"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

var version = "dev"

type options struct {
	socket, peerExe, peerScript string
	lockExes                    []string
}

func parseFlags(args []string, getenv func(string) string) (options, error) {
	fs := flag.NewFlagSet("jarvis-cu", flag.ContinueOnError)
	var o options
	var lock string
	fs.StringVar(&o.socket, "socket", "", "control socket (default $XDG_RUNTIME_DIR/jarvis/cu.sock)")
	fs.StringVar(&o.peerExe, "peer-exe", "/usr/lib/jarvis/node/bin/node", "the only program allowed to connect")
	fs.StringVar(&o.peerScript, "peer-script", "/usr/lib/jarvis/daemon/jarvisd.mjs", "its argv[1] (empty: no check, tests only)")
	fs.StringVar(&lock, "lock-exe", "/usr/bin/jarvis-lock,/usr/bin/swaylock", "comma-separated lock-screen programs")
	if err := fs.Parse(args); err != nil {
		return o, err
	}
	if o.socket == "" {
		rt := getenv("XDG_RUNTIME_DIR")
		if rt == "" {
			return o, errors.New("XDG_RUNTIME_DIR is not set")
		}
		o.socket = filepath.Join(rt, "jarvis", "cu.sock")
	}
	for _, s := range strings.Split(lock, ",") {
		if s = strings.TrimSpace(s); s != "" {
			o.lockExes = append(o.lockExes, s)
		}
	}
	return o, nil
}

// unsupportedHandler answers when the desktop lacks a needed protocol.
type unsupportedHandler struct{ why string }

func (u unsupportedHandler) Handle(op string, _ []byte) (any, error) {
	if op == "end" {
		return nil, nil
	}
	return nil, proto.Errorf(proto.CodeUnsupported, "computer use is not available on this desktop: %s", u.why)
}

func (unsupportedHandler) Disconnected() {}

// waylandDesktop adapts *wlcu.Client to session.Desktop, caching devices.
type waylandDesktop struct {
	c    *wlcu.Client
	mu   sync.Mutex
	ptrs map[string]*wlcu.Pointer
	kb   *wlcu.Keyboard
}

func (w *waylandDesktop) Toplevels() ([]wlcu.Toplevel, error)    { return w.c.Toplevels() }
func (w *waylandDesktop) Current() []wlcu.Toplevel               { return w.c.Current() }
func (w *waylandDesktop) Outputs() ([]wlcu.Output, error)        { return w.c.Outputs() }
func (w *waylandDesktop) Activate(id string) error               { return w.c.Activate(id) }
func (w *waylandDesktop) SetFullscreen(id string, on bool) error { return w.c.SetFullscreen(id, on) }
func (w *waylandDesktop) Capture(out string) (img.Frame, error)  { return w.c.Capture(out) }

func (w *waylandDesktop) Pointer(out string) (session.Pointer, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if p := w.ptrs[out]; p != nil {
		return p, nil
	}
	p, err := w.c.NewPointer(out)
	if err != nil {
		return nil, err
	}
	w.ptrs[out] = p
	return p, nil
}

func (w *waylandDesktop) Keyboard() (session.Keyboard, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.kb == nil {
		kb, err := w.c.NewKeyboard()
		if err != nil {
			return nil, err
		}
		w.kb = kb
	}
	return w.kb, nil
}

// prime creates the keyboard (with a keymap) and one pointer per output.
func (w *waylandDesktop) prime(logger *log.Logger) {
	if kb, err := w.Keyboard(); err != nil {
		logger.Printf("virtual keyboard: %v", err)
	} else if err := kb.(*wlcu.Keyboard).Prime(); err != nil {
		logger.Printf("virtual keyboard keymap: %v", err)
	}
	outs, err := w.c.Outputs()
	if err != nil {
		logger.Printf("outputs: %v", err)
		return
	}
	for _, o := range outs {
		if _, err := w.Pointer(o.Name); err != nil {
			logger.Printf("virtual pointer on %s: %v", o.Name, err)
		}
	}
}

// a11y keeps one AT-SPI password watch, restarting it at most every 10 s.
type a11y struct {
	mu   sync.Mutex
	w    *guard.PasswordWatch
	stop func()
	last time.Time
}

func (a *a11y) ensure() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.w.Live() || time.Since(a.last) < 10*time.Second {
		return
	}
	a.last = time.Now()
	if a.stop != nil {
		a.stop()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w, stop, err := guard.StartPasswordWatch(ctx)
	if err != nil {
		log.Printf("password-field checks unavailable: %v", err)
		a.w, a.stop = nil, nil
		return
	}
	a.w, a.stop = w, stop
}

func (a *a11y) check(ctx context.Context) (bool, error) {
	a.ensure()
	a.mu.Lock()
	w := a.w
	a.mu.Unlock()
	if w == nil {
		return false, guard.ErrNoA11y
	}
	return w.PasswordFocused(ctx)
}

// describe shares the password watch's live accessibility connection.
func (a *a11y) describe(ctx context.Context, title string, x, y int) (string, string) {
	a.ensure()
	a.mu.Lock()
	w := a.w
	a.mu.Unlock()
	return w.DescribeAt(ctx, title, x, y)
}

// frameSize shares the same connection.
func (a *a11y) frameSize(ctx context.Context, title string) (int, int, bool) {
	a.ensure()
	a.mu.Lock()
	w := a.w
	a.mu.Unlock()
	return w.FrameSize(ctx, title)
}

// describeFocused shares the same connection.
func (a *a11y) describeFocused(ctx context.Context, title string) (string, string) {
	a.ensure()
	a.mu.Lock()
	w := a.w
	a.mu.Unlock()
	return w.DescribeFocused(ctx, title)
}

func run(o options) error {
	ln, err := server.Listen(o.socket)
	if err != nil {
		return err
	}
	defer ln.Close()
	check := server.JarvisdCheck("/proc", server.Expected{Exe: o.peerExe, Script: o.peerScript, UID: os.Getuid()})
	logger := log.Default()

	path, err := wl.SocketPath(os.Getenv, os.ReadDir)
	var client *wlcu.Client
	if err == nil {
		var mgrRef atomic.Pointer[session.Manager]
		client, err = wlcu.Dial(path, wlcu.Options{OnChange: func() {
			if m := mgrRef.Load(); m != nil {
				m.FocusChanged()
			}
		}})
		if err == nil {
			defer client.Close()
			srvRef := &atomic.Pointer[server.Server]{}
			det := activity.New(activity.RealClock(), activity.Config{IdleTimeout: 50 * time.Millisecond, Grace: 150 * time.Millisecond}, func() {
				if m := mgrRef.Load(); m != nil {
					m.Pause(proto.ReasonPhysicalInput)
				}
			})
			if _, err := client.WatchIdle(50*time.Millisecond, det.Event); err != nil {
				return err
			}
			desk := &waylandDesktop{c: client, ptrs: map[string]*wlcu.Pointer{}}
			acc := &a11y{}
			acc.ensure() // start tracking focus now, before the first session
			lock := guard.DefaultLockWatch(o.lockExes)
			home, _ := os.UserHomeDir()
			mgr := session.New(session.Deps{
				Desktop:         desk,
				Apps:            func() *policy.AppIndex { return policy.NewAppIndex(desktop.IndexAll(desktop.DefaultDirs(home))) },
				Locked:          lock.Locked,
				Password:        acc.check,
				DescribeAt:      acc.describe,
				DescribeFocused: acc.describeFocused,
				FrameSize:       acc.frameSize,
				Activity:        det,
				Push: func(ev proto.Event) {
					if s := srvRef.Load(); s != nil {
						go s.Push(ev) // never block the Wayland read loop on the socket
					}
				},
			})
			mgrRef.Store(mgr)
			// Create the virtual keyboard and pointers now, at login, not at
			// the first action: adding a seat device makes labwc resend the
			// seat capabilities, and GTK3 apps then recreate their keyboard
			// and get no keyboard focus until focus changes (seen with GIMP
			// on labwc 0.8.3: every key of a session was dropped).
			desk.prime(logger)
			go lock.Poll(100*time.Millisecond, nil, mgr.LockedNow)
			srv := server.New(ln, check, mgr, logger)
			srvRef.Store(srv)
			go func() {
				<-client.Dead()
				logger.Printf("lost the desktop connection: %v", client.Err())
				os.Exit(1)
			}()
			logger.Printf("jarvis-cu %s ready on %s", version, o.socket)
			return srv.Serve()
		}
	}
	why := err.Error()
	var ue *wlcu.UnsupportedError
	if errors.As(err, &ue) {
		why = ue.Error()
	}
	logger.Printf("computer use unavailable: %s", why)
	return server.New(ln, check, unsupportedHandler{why: why}, logger).Serve()
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-cu: ")
	o, err := parseFlags(os.Args[1:], os.Getenv)
	if err != nil {
		fmt.Fprintln(os.Stderr, "jarvis-cu:", err)
		os.Exit(2)
	}
	if err := run(o); err != nil {
		log.Fatal(err)
	}
}
