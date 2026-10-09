package pkgtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/i18n"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
)

const itemsSchema = `{"type":"object","properties":{"items":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"object","properties":{"source":{"type":"string","enum":["apt","flatpak"]},"id":{"type":"string","minLength":1,"maxLength":255}},"required":["source","id"],"additionalProperties":false}}},"required":["items"],"additionalProperties":false}`

// changeTools are the two confirm tools; they only ever act through the
// helper. Both declare batch "items" (contracts §6.1): jarvisd shows one card
// item per element and calls the tool once with the ticked elements.
func (d Deps) changeTools() []mcp.Tool {
	return []mcp.Tool{
		{
			Name: "pkg.install",
			Description: "Install apps. Prefer source \"apt\" when the app exists in Debian; use \"flatpak\" (Flathub) when it does not, or when the user asks for the latest version. " +
				"The user confirms on a card first.",
			InputSchema: itemsSchema,
			Risk:        mcp.RiskConfirm,
			Batch:       "items",
			Call:        func(ctx context.Context, raw json.RawMessage) (any, error) { return d.change(ctx, raw, true) },
			Describe: func(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
				return d.describe(ctx, raw, true)
			},
		},
		{
			Name:        "pkg.remove",
			Description: "Remove installed apps (same item shape as pkg.install). The user confirms on a card first.",
			InputSchema: itemsSchema,
			Risk:        mcp.RiskConfirm,
			Batch:       "items",
			Call:        func(ctx context.Context, raw json.RawMessage) (any, error) { return d.change(ctx, raw, false) },
			Describe: func(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
				return d.describe(ctx, raw, false)
			},
		},
	}
}

func decodeItems(raw json.RawMessage) ([]pkgRef, error) {
	var in struct {
		Items []pkgRef `json:"items"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if len(in.Items) < 1 || len(in.Items) > 10 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "items must hold 1 to 10 apps")
	}
	seen := map[pkgRef]bool{}
	for _, it := range in.Items {
		if err := it.check(); err != nil {
			return nil, err
		}
		if seen[it] {
			return nil, mcp.Errorf(mcp.CodeInvalid, "%s listed twice", it.ID)
		}
		seen[it] = true
	}
	return in.Items, nil
}

// Installed is one installed item; Version is "" when it could not be read.
type Installed struct {
	Source  string `json:"source"`
	ID      string `json:"id"`
	Version string `json:"version"`
}

// Failed is one item that did not happen.
type Failed struct {
	Source  string `json:"source"`
	ID      string `json:"id"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// BatchBudget is the longest one pkg.install or pkg.remove call may run. An
// item is started only while a full helper call (PackageCallTimeout) still
// fits, so the batch always ends before jarvisd's action timeout
// (ACTION_TOOL_TIMEOUT_MS, 85 min, packages/core/src/agent/tool-registry.ts)
// and jarvisd never reports "failed" for an install that is still running.
const BatchBudget = 80 * time.Minute

// change installs or removes items one at a time, so one app failing does
// not hide that the others worked. Once a helper call starts it is never
// cancelled (design §5: a running install is not killed midway); a Stop
// between items leaves the rest undone and says so.
func (d Deps) change(ctx context.Context, raw json.RawMessage, install bool) (any, error) {
	items, err := decodeItems(raw)
	if err != nil {
		return nil, err
	}
	installed, removed, failed := []Installed{}, []pkgRef{}, []Failed{}
	start := d.now()
	for _, it := range items {
		if ctx.Err() != nil {
			failed = append(failed, Failed{it.Source, it.ID, string(mcp.CodeFailed), "stopped before this app was started"})
			continue
		}
		if d.now().Sub(start) > BatchBudget-helperapi.PackageCallTimeout {
			failed = append(failed, Failed{it.Source, it.ID, string(mcp.CodeFailed), "not started: the earlier apps took too long; ask again to install it"})
			continue
		}
		out, err := d.callHelper(context.WithoutCancel(ctx), it, install)
		if f, bad := failure(it, out, err); bad {
			failed = append(failed, f)
			continue
		}
		if install {
			installed = append(installed, Installed{Source: it.Source, ID: it.ID, Version: d.installedVersion(ctx, it)})
		} else {
			removed = append(removed, it)
		}
	}
	if install {
		return map[string]any{"installed": installed, "failed": failed}, nil
	}
	return map[string]any{"removed": removed, "failed": failed}, nil
}

func (d Deps) callHelper(ctx context.Context, it pkgRef, install bool) (helperapi.Outcome, error) {
	switch {
	case it.Source == "apt" && install:
		return d.Helper.AptInstall(ctx, []string{it.ID})
	case it.Source == "apt":
		return d.Helper.AptRemove(ctx, []string{it.ID})
	case install:
		return d.Helper.FlatpakInstall(ctx, []string{it.ID})
	default:
		return d.Helper.FlatpakRemove(ctx, []string{it.ID})
	}
}

func failure(it pkgRef, out helperapi.Outcome, err error) (Failed, bool) {
	if err != nil {
		var he *helperapi.Error
		if errors.As(err, &he) {
			return Failed{it.Source, it.ID, he.Code(), he.Error()}, true
		}
		return Failed{it.Source, it.ID, string(mcp.CodeFailed), err.Error()}, true
	}
	if out.OK {
		return Failed{}, false
	}
	c := mcp.CodeFailed
	if helperapi.LooksOffline(out.StderrTail) {
		c = mcp.CodeOffline
	}
	return Failed{it.Source, it.ID, string(c), fmt.Sprintf("exit code %d: %s", out.ExitCode, lastLines(out.StderrTail, 5))}, true
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func (d Deps) installedVersion(ctx context.Context, it pkgRef) string {
	if it.Source == "apt" {
		res, err := d.run(ctx, queryTimeout, "dpkg-query", "-W", dpkgFormat, "--", it.ID)
		if st := parse.DpkgQuery(string(res.Stdout)); err == nil && len(st) > 0 {
			return st[0].Version
		}
		return ""
	}
	res, err := d.run(ctx, queryTimeout, "flatpak", "info", "--system", it.ID)
	if err != nil {
		return ""
	}
	fi, _ := parse.FlatpakDetails(string(res.Stdout))
	return fi.Version
}

// describe builds the card text in the language jarvis.describe asked
// for. It only reads (apt-cache, dpkg-query, flatpak remote-info):
// jarvis.describe must have no side effects.
func (d Deps) describe(ctx context.Context, raw json.RawMessage, install bool) (mcp.Description, error) {
	items, err := decodeItems(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	l := i18n.FromContext(ctx)
	t := cardText.Get(l)
	one, many := t.RemoveOne, t.RemoveMany
	if install {
		one, many = t.InstallOne, t.InstallMany
	}
	var names, lines []string
	for _, it := range items {
		info, lerr := d.lookup(ctx, it)
		name := it.ID
		if lerr == nil && info.Name != "" && it.Source == "flatpak" {
			name = info.Name
		}
		names = append(names, name)
		lines = append(lines, itemLine(l, it, info, lerr, install))
	}
	// jarvisd describes one element at a time (contracts §6.1); the
	// many-item form remains for a client that does not split batches.
	title := i18n.Sprintf(l, one, names[0])
	if len(items) > 1 {
		title = i18n.Sprintf(l, many, len(items), strings.Join(names, ", "))
	}
	return mcp.Description{Title: title, Detail: strings.Join(lines, "\n"), Source: sourceOf(items[0])}, nil
}

func sourceName(t pkgCard, source string) string {
	if source == "flatpak" {
		return t.SourceFlathub
	}
	return t.SourceDebian
}

func itemLine(l i18n.Lang, it pkgRef, info Info, err error, install bool) string {
	t := cardText.Get(l)
	from := sourceName(t, it.Source)
	if err != nil {
		if install {
			return i18n.Sprintf(l, t.LookupFailed, it.ID, from, mcp.AsToolError(err).Message)
		}
		return i18n.Sprintf(l, t.RemoveUnknown, it.ID, from)
	}
	if install {
		return i18n.Sprintf(l, t.InstallLine, it.ID, info.Version, from, humanBytes(l, info.DownloadBytes))
	}
	return i18n.Sprintf(l, t.RemoveLine, it.ID, info.Version, from, humanBytes(l, info.InstalledBytes))
}

func sourceOf(it pkgRef) mcp.Source {
	if it.Source == "flatpak" {
		return mcp.SourceFlathub
	}
	return mcp.SourceDebian
}

// HumanBytes formats a size the way an English card shows it: "45 MB", "3.2 GB".
func HumanBytes(n int64) string { return humanBytes(i18n.EN, n) }

func humanBytes(l i18n.Lang, n int64) string {
	t := cardText.Get(l)
	units := []string{"", t.UnitKB, t.UnitMB, t.UnitGB, t.UnitTB}
	f := float64(n)
	i := 0
	for f >= 1000 && i < len(units)-1 {
		f /= 1000
		i++
	}
	if i == 0 {
		return fmt.Sprintf(t.UnitBytes, n)
	}
	if f < 10 {
		return fmt.Sprintf("%.1f %s", f, units[i])
	}
	return fmt.Sprintf("%.0f %s", f, units[i])
}
