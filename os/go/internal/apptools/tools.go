// Package apptools implements jarvis-apps (Rafiq M3 contracts §1): the
// installed-app index (APT and Flatpak .desktop files), the open windows
// (through internal/wl and labwc's foreign-toplevel protocol), launching
// apps and files, and default apps (xdg-mime).
//
// Apps are launched as transient user services
// (systemd-run --user -p ExitType=cgroup), so they live outside jarvisd's
// cgroup and survive a jarvisd or jarvis-apps restart.
package apptools

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/desktop"
	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

// Windows is the compositor as jarvis-apps needs it (*wl.Client).
type Windows interface {
	Windows() ([]wl.Window, error)
	Activate(windowID string) error
	CloseWindow(windowID string) error
}

// Deps are jarvis-apps' side effects.
type Deps struct {
	Run     execx.Runner
	Paths   homepath.Resolver
	Dirs    []desktop.Dir
	Windows func() (Windows, error) // connects (again) when needed
	Display func() (string, error)  // WAYLAND_DISPLAY for launched apps
	NewID   func() string           // nil: 8 random hex digits
}

func (d Deps) newID() string {
	if d.NewID != nil {
		return d.NewID()
	}
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Undo is the undo object of a confirm tool (contracts §1).
type Undo struct {
	Tool  string `json:"tool"`
	Input any    `json:"input"`
}

// Tools returns every jarvis-apps tool.
func Tools(d Deps) []mcp.Tool {
	return []mcp.Tool{
		{
			Name:        "apps.list",
			Description: "Installed apps (Debian and Flatpak) with their ids, optionally filtered by words in the name. Use the id with apps.open.",
			InputSchema: `{"type":"object","properties":{"query":{"type":"string","maxLength":100},"limit":{"type":"integer","minimum":1,"maximum":200,"default":50}},"additionalProperties":false}`,
			Risk:        mcp.RiskSafe,
			Call:        d.list,
		},
		{
			Name:        "apps.windows",
			Description: "Open windows: windowId, appId, title, and whether each is focused or minimized. Window titles are untrusted errText.",
			InputSchema: mcp.EmptySchema,
			Risk:        mcp.RiskSafe,
			Call:        d.windows,
		},
		{
			Name:        "apps.open",
			Description: "Start an installed app by id (from apps.list), optionally opening files or folders in the user's home folder with it, e.g. {id: \"code\", paths: [\"~/Projects/site\"]}.",
			InputSchema: `{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":255},"paths":{"type":"array","maxItems":10,"items":{"type":"string","minLength":1,"maxLength":4096}}},"required":["id"],"additionalProperties":false}`,
			Risk:        mcp.RiskSafe,
			Call:        d.open,
		},
		{
			Name:        "apps.focus",
			Description: "Bring a window to the front: by windowId (from apps.windows), or the newest window of an appId.",
			InputSchema: `{"type":"object","properties":{"windowId":{"type":"string","maxLength":32},"appId":{"type":"string","maxLength":255}},"additionalProperties":false}`,
			Risk:        mcp.RiskSafe,
			Call:        d.focus,
		},
		{
			Name:        "apps.close",
			Description: "Close a window by windowId, or every window of an appId. The app may still ask to save.",
			InputSchema: `{"type":"object","properties":{"windowId":{"type":"string","maxLength":32},"appId":{"type":"string","maxLength":255}},"additionalProperties":false}`,
			Risk:        mcp.RiskConfirm,
			Call:        d.close,
			Describe:    d.describeClose,
		},
		{
			Name:        "apps.open_path",
			Description: "Open a file or folder under the user's home folder with its default app.",
			InputSchema: `{"type":"object","properties":{"target":{"type":"string","minLength":1,"maxLength":4096}},"required":["target"],"additionalProperties":false}`,
			Risk:        mcp.RiskSafe,
			Call:        d.openPath,
		},
		{
			Name:        "apps.open_url",
			Description: "Open an http, https or mailto address with its default app.",
			InputSchema: `{"type":"object","properties":{"target":{"type":"string","minLength":1,"maxLength":2048}},"required":["target"],"additionalProperties":false}`,
			Risk:        mcp.RiskConfirm,
			Call:        d.openURL,
			Describe:    d.describeOpenURL,
		},
		{
			Name:        "apps.set_default",
			Description: "Make an installed app the default for a MIME type or link kind, e.g. {mimeType: \"x-scheme-handler/https\", appId: \"firefox-esr\"} for the web browser, or \"application/pdf\".",
			InputSchema: `{"type":"object","properties":{"mimeType":{"type":"string","minLength":3,"maxLength":255},"appId":{"type":"string","minLength":1,"maxLength":255}},"required":["mimeType","appId"],"additionalProperties":false}`,
			Risk:        mcp.RiskConfirm,
			Call:        d.setDefault,
			Describe:    d.describeSetDefault,
		},
	}
}

// AppInfo is one apps.list result.
type AppInfo struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	NameAr     string   `json:"nameAr"`
	Source     string   `json:"source"`
	Categories []string `json:"categories"`
}

func (d Deps) index() []desktop.Entry { return desktop.Index(d.Dirs) }

func (d Deps) app(id string) (desktop.Entry, error) {
	if id == "" || utf8.RuneCountInString(id) > 255 || !printable(id) {
		return desktop.Entry{}, mcp.Errorf(mcp.CodeInvalid, "%s", errText.BadID)
	}
	for _, e := range d.index() {
		if e.ID == id {
			return e, nil
		}
	}
	return desktop.Entry{}, mcp.Errorf(mcp.CodeNotFound, errText.NoApp, id)
}

func matches(e desktop.Entry, words []string) bool {
	hay := strings.ToLower(strings.Join(append([]string{e.ID, e.Name, e.NameAr, e.StartupWMClass}, e.Keywords...), " "))
	for _, w := range words {
		if !strings.Contains(hay, w) {
			return false
		}
	}
	return true
}

func (d Deps) list(_ context.Context, raw json.RawMessage) (any, error) {
	in := struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}{Limit: 50}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if utf8.RuneCountInString(in.Query) > 100 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", errText.BadQuery)
	}
	if in.Limit < 1 || in.Limit > 200 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", errText.BadLimit)
	}
	words := strings.Fields(strings.ToLower(in.Query))
	apps, truncated := []AppInfo{}, false
	for _, e := range d.index() {
		if !matches(e, words) {
			continue
		}
		if len(apps) == in.Limit {
			truncated = true
			break
		}
		apps = append(apps, AppInfo{ID: e.ID, Name: e.Name, NameAr: e.NameAr, Source: e.Source, Categories: e.Categories})
	}
	return map[string]any{"apps": apps, "truncated": truncated}, nil
}

// WindowInfo is one apps.windows result: the compositor's window plus the
// installed app it belongs to ("" when unknown).
type WindowInfo struct {
	wl.Window
	DesktopID string `json:"desktopId"`
}

// desktopFor maps a Wayland app_id to an installed app id.
func desktopFor(appID string, apps []desktop.Entry) string {
	a := strings.ToLower(appID)
	for _, e := range apps {
		if strings.ToLower(e.ID) == a || (e.StartupWMClass != "" && strings.ToLower(e.StartupWMClass) == a) {
			return e.ID
		}
	}
	for _, e := range apps {
		id := strings.ToLower(e.ID)
		if i := strings.LastIndex(id, "."); i >= 0 && id[i+1:] == a {
			return e.ID
		}
	}
	return ""
}

func (d Deps) client() (Windows, error) {
	if d.Windows == nil {
		return nil, mcp.Errorf(mcp.CodeFailed, errText.NoWayland, "no compositor")
	}
	w, err := d.Windows()
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, errText.NoWayland, err)
	}
	return w, nil
}

func (d Deps) listWindows() ([]WindowInfo, Windows, error) {
	c, err := d.client()
	if err != nil {
		return nil, nil, err
	}
	ws, err := c.Windows()
	if err != nil {
		return nil, nil, mcp.Errorf(mcp.CodeFailed, errText.NoWayland, err)
	}
	apps := d.index()
	out := make([]WindowInfo, 0, len(ws))
	for _, w := range ws {
		out = append(out, WindowInfo{Window: w, DesktopID: desktopFor(w.AppID, apps)})
	}
	return out, c, nil
}

func (d Deps) windows(_ context.Context, raw json.RawMessage) (any, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	ws, _, err := d.listWindows()
	if err != nil {
		return nil, err
	}
	return map[string]any{"windows": ws}, nil
}

// pick resolves {windowId} or {appId} to windows (newest last).
func (d Deps) pick(raw json.RawMessage) ([]WindowInfo, Windows, string, error) {
	var in struct {
		WindowID string `json:"windowId"`
		AppID    string `json:"appId"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, nil, "", err
	}
	if (in.WindowID == "") == (in.AppID == "") || utf8.RuneCountInString(in.WindowID) > 32 || utf8.RuneCountInString(in.AppID) > 255 || !printable(in.WindowID+in.AppID) {
		return nil, nil, "", mcp.Errorf(mcp.CodeInvalid, "%s", errText.OneOf)
	}
	ws, c, err := d.listWindows()
	if err != nil {
		return nil, nil, "", err
	}
	var out []WindowInfo
	for _, w := range ws {
		if (in.WindowID != "" && w.ID == in.WindowID) ||
			(in.AppID != "" && (strings.EqualFold(w.AppID, in.AppID) || strings.EqualFold(w.DesktopID, in.AppID))) {
			out = append(out, w)
		}
	}
	name := in.WindowID + in.AppID
	if len(out) == 0 {
		return nil, nil, name, mcp.Errorf(mcp.CodeNotFound, errText.NotOpen, name)
	}
	return out, c, name, nil
}

func (d Deps) focus(_ context.Context, raw json.RawMessage) (any, error) {
	ws, c, _, err := d.pick(raw)
	if err != nil {
		return nil, err
	}
	w := ws[len(ws)-1]
	if err := c.Activate(w.ID); err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "%v", err)
	}
	return map[string]any{"windowId": w.ID, "appId": w.AppID, "title": w.Title}, nil
}

func (d Deps) close(_ context.Context, raw json.RawMessage) (any, error) {
	ws, c, _, err := d.pick(raw)
	if err != nil {
		return nil, err
	}
	closed := []string{}
	for _, w := range ws {
		if err := c.CloseWindow(w.ID); err != nil && !errors.Is(err, wl.ErrNoWindow) {
			return nil, mcp.Errorf(mcp.CodeFailed, "%v", err)
		}
		closed = append(closed, w.ID)
	}
	var undo *Undo
	if id := ws[0].DesktopID; id != "" {
		undo = &Undo{Tool: "apps.open", Input: map[string]string{"id": id}}
	}
	return map[string]any{"closed": closed, "undo": undo}, nil
}

func (d Deps) describeClose(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	ws, _, name, err := d.pick(raw)
	if err != nil {
		return mcp.Description{Title: i18n.Sprintf(l, t.CloseTitle, name), Detail: i18n.Iso(l, mcp.AsToolError(err).Message), Source: mcp.SourceSystem}, nil
	}
	if len(ws) == 1 {
		return mcp.Description{Title: i18n.Sprintf(l, t.CloseTitle, ws[0].Title), Detail: i18n.Sprintf(l, t.CloseDetail, ws[0].AppID), Source: mcp.SourceSystem}, nil
	}
	return mcp.Description{Title: i18n.Sprintf(l, t.CloseAllTitle, len(ws), ws[0].AppID), Detail: i18n.Sprintf(l, t.CloseDetail, ws[0].AppID), Source: mcp.SourceSystem}, nil
}

var unitUnsafe = regexp.MustCompile(`[^A-Za-z0-9_.-]`)

// launch starts argv as a transient user service of its own.
func (d Deps) launch(ctx context.Context, slug string, argv []string) (string, error) {
	unit := "app-jarvis-" + unitUnsafe.ReplaceAllString(slug, "_") + "-" + d.newID()
	args := []string{"--user", "--quiet", "--collect", "--unit=" + unit, "-p", "ExitType=cgroup"}
	if d.Display != nil {
		if disp, err := d.Display(); err == nil {
			args = append(args, "--setenv=WAYLAND_DISPLAY="+disp, "--setenv=XDG_SESSION_TYPE=wayland")
		}
	}
	args = append(append(args, "--"), argv...)
	res, err := d.Run.Run(ctx, execx.Cmd{Name: "systemd-run", Args: args, Timeout: 15 * time.Second})
	if err != nil {
		return "", mcp.Errorf(mcp.CodeFailed, errText.LaunchFailed, err)
	}
	if res.ExitCode != 0 {
		return "", mcp.Errorf(mcp.CodeFailed, errText.LaunchFailed, strings.TrimSpace(string(res.Stderr)))
	}
	return unit + ".service", nil
}

func (d Deps) open(ctx context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		ID    string   `json:"id"`
		Paths []string `json:"paths"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if len(in.Paths) > 10 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s", errText.TooManyPaths)
	}
	e, err := d.app(in.ID)
	if err != nil {
		return nil, err
	}
	var targets, shown []string
	for _, p := range in.Paths {
		r, err := d.Paths.Existing(p)
		if err != nil {
			return nil, err
		}
		targets, shown = append(targets, r.Target), append(shown, r.Display)
	}
	argv, err := desktop.ExpandExec(e, targets)
	if errors.Is(err, desktop.ErrNoFiles) {
		return nil, mcp.Errorf(mcp.CodeInvalid, "%s: %v", e.Name, err)
	}
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "%s: %v", e.Name, err)
	}
	if e.Terminal {
		argv = append([]string{"x-terminal-emulator", "-e"}, argv...)
	}
	unit, err := d.launch(ctx, e.ID, argv)
	if err != nil {
		return nil, err
	}
	if shown == nil {
		shown = []string{}
	}
	return map[string]any{"id": e.ID, "name": e.Name, "unit": unit, "paths": shown}, nil
}

// target is a resolved home path or URL, selected by the tool.
type target struct {
	file    homepath.Path
	url     string
	display string
}

func printable(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) || r == ' ' {
			return false
		}
	}
	return utf8.ValidString(s)
}

func (d Deps) resolveTarget(raw json.RawMessage, isURL bool) (target, error) {
	var in struct {
		Target string `json:"target"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return target{}, err
	}
	if isURL {
		u, err := url.Parse(in.Target)
		ok := err == nil && printable(in.Target) && len(in.Target) <= 2048 &&
			((u.Scheme == "http" || u.Scheme == "https") && u.Host != "" || u.Scheme == "mailto" && u.Opaque != "")
		if !ok {
			return target{}, mcp.Errorf(mcp.CodeInvalid, errText.BadURL, in.Target)
		}
		return target{url: u.String(), display: u.String()}, nil
	}
	p, err := d.Paths.Existing(in.Target)
	if err != nil {
		return target{}, err
	}
	st, err := os.Stat(p.Target)
	if err != nil || !(st.Mode().IsRegular() || st.IsDir()) {
		return target{}, mcp.Errorf(mcp.CodeInvalid, errText.NotFolderOrFile, p.Display)
	}
	return target{file: p, display: p.Display}, nil
}

func (d Deps) openPath(ctx context.Context, raw json.RawMessage) (any, error) {
	t, err := d.resolveTarget(raw, false)
	if err != nil {
		return nil, err
	}
	arg := t.file.Target
	unit, err := d.launch(ctx, "xdg-open", []string{"/usr/bin/xdg-open", arg})
	if err != nil {
		return nil, err
	}
	return map[string]any{"target": t.display, "kind": "file", "unit": unit, "undo": nil}, nil
}

func (d Deps) openURL(ctx context.Context, raw json.RawMessage) (any, error) {
	t, err := d.resolveTarget(raw, true)
	if err != nil {
		return nil, err
	}
	unit, err := d.launch(ctx, "xdg-open", []string{"/usr/bin/xdg-open", t.url})
	if err != nil {
		return nil, err
	}
	return map[string]any{"target": t.display, "kind": "url", "unit": unit, "undo": nil}, nil
}

func (d Deps) describeOpenURL(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	tg, err := d.resolveTarget(raw, true)
	if err != nil {
		return mcp.Description{}, err
	}
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	kind := t.KindWeb
	if strings.HasPrefix(tg.url, "mailto:") {
		kind = t.KindEmail
	}
	return mcp.Description{Title: i18n.Sprintf(l, t.OpenURLTitle, tg.display), Detail: i18n.Sprintf(l, t.OpenURLDetail, kind), Source: mcp.SourceNetwork}, nil
}

var mimeRe = regexp.MustCompile(`^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$`)

type defaultReq struct {
	MimeType string `json:"mimeType"`
	AppID    string `json:"appId"`
}

func (d Deps) checkDefault(raw json.RawMessage) (defaultReq, desktop.Entry, error) {
	var in defaultReq
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return in, desktop.Entry{}, err
	}
	if !mimeRe.MatchString(in.MimeType) {
		return in, desktop.Entry{}, mcp.Errorf(mcp.CodeInvalid, errText.BadMime, in.MimeType)
	}
	e, err := d.app(in.AppID)
	if err != nil {
		return in, e, err
	}
	for _, m := range e.MimeTypes {
		if m == in.MimeType {
			return in, e, nil
		}
	}
	return in, e, mcp.Errorf(mcp.CodeInvalid, errText.NoMime, e.Name, in.MimeType)
}

// currentDefault asks xdg-mime; "" when none is set.
func (d Deps) currentDefault(ctx context.Context, mime string) (string, error) {
	res, err := d.Run.Run(ctx, execx.Cmd{Name: "xdg-mime", Args: []string{"query", "default", mime}, Timeout: 10 * time.Second})
	if err != nil {
		return "", mcp.Errorf(mcp.CodeFailed, errText.MimeFailed, err)
	}
	if res.ExitCode != 0 {
		return "", mcp.Errorf(mcp.CodeFailed, errText.MimeFailed, strings.TrimSpace(string(res.Stderr)))
	}
	return strings.TrimSuffix(strings.TrimSpace(string(res.Stdout)), ".desktop"), nil
}

var setMu sync.Mutex

func (d Deps) setDefault(ctx context.Context, raw json.RawMessage) (any, error) {
	in, e, err := d.checkDefault(raw)
	if err != nil {
		return nil, err
	}
	setMu.Lock()
	defer setMu.Unlock()
	prev, err := d.currentDefault(ctx, in.MimeType)
	if err != nil {
		return nil, err
	}
	res, err := d.Run.Run(ctx, execx.Cmd{Name: "xdg-mime", Args: []string{"default", e.ID + ".desktop", in.MimeType}, Timeout: 10 * time.Second})
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, errText.MimeFailed, err)
	}
	if res.ExitCode != 0 {
		return nil, mcp.Errorf(mcp.CodeFailed, errText.MimeFailed, strings.TrimSpace(string(res.Stderr)))
	}
	var previous any
	var undo *Undo
	if prev != "" {
		previous = prev
		if prev != e.ID {
			undo = &Undo{Tool: "apps.set_default", Input: map[string]string{"mimeType": in.MimeType, "appId": prev}}
		}
	}
	return map[string]any{"mimeType": in.MimeType, "previous": previous, "current": e.ID, "undo": undo}, nil
}

func (d Deps) describeSetDefault(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	in, e, err := d.checkDefault(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	prev, err := d.currentDefault(ctx, in.MimeType)
	if err != nil {
		return mcp.Description{}, err
	}
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	if prev == "" {
		prev = t.None
	}
	name := e.Name
	if l == i18n.AR && e.NameAr != "" {
		name = e.NameAr
	}
	return mcp.Description{Title: i18n.Sprintf(l, t.DefaultTitle, name, in.MimeType), Detail: i18n.Sprintf(l, t.DefaultDetail, prev, e.ID), Source: mcp.SourceSystem}, nil
}

// WaylandWindows returns a Deps.Windows that keeps one compositor
// connection and reconnects after it dies (window ids then start over).
func WaylandWindows(getenv func(string) string, readDir func(string) ([]os.DirEntry, error)) func() (Windows, error) {
	var mu sync.Mutex
	var cur *wl.Client
	return func() (Windows, error) {
		mu.Lock()
		defer mu.Unlock()
		if cur != nil && cur.Alive() {
			return cur, nil
		}
		path, err := wl.SocketPath(getenv, readDir)
		if err != nil {
			return nil, err
		}
		c, err := wl.Dial(path, 2*time.Second)
		if err != nil {
			return nil, err
		}
		cur = c
		return c, nil
	}
}

// WaylandDisplay returns a Deps.Display backed by wl.Display.
func WaylandDisplay(getenv func(string) string, readDir func(string) ([]os.DirEntry, error)) func() (string, error) {
	return func() (string, error) { return wl.Display(getenv, readDir) }
}
