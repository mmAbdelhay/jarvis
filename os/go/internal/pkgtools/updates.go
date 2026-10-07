package pkgtools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

// UpdateItem is one entry of updates.list (M2 contracts §2).
type UpdateItem struct {
	Source   string `json:"source"`
	ID       string `json:"id"`
	From     string `json:"from"`
	To       string `json:"to"`
	Security bool   `json:"security"`
}

// UpdateCache remembers the last updates.list result in this process, so
// jarvis.describe for updates.apply (which only receives {source, id}) can
// show "0.1.0 → 0.2.0" without running the simulation again.
type UpdateCache struct {
	mu    sync.Mutex
	items map[pkgRef]UpdateItem
}

func (c *UpdateCache) store(items []UpdateItem) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = map[pkgRef]UpdateItem{}
	for _, it := range items {
		c.items[pkgRef{it.Source, it.ID}] = it
	}
}

func (c *UpdateCache) get(r pkgRef) (UpdateItem, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	it, ok := c.items[r]
	return it, ok
}

const updatesItemsSchema = `{"type":"object","properties":{"items":{"type":"array","minItems":1,"maxItems":200,"items":{"type":"object","properties":{"source":{"type":"string","enum":["apt","flatpak"]},"id":{"type":"string","minLength":1,"maxLength":255}},"required":["source","id"],"additionalProperties":false}}},"required":["items"],"additionalProperties":false}`

// listTimeout bounds the apt-get simulation and each flatpak query.
const listTimeout = 2 * time.Minute

func (d Deps) updateTools() []mcp.Tool {
	return []mcp.Tool{
		{
			Name:        "updates.list",
			Description: "List available updates for installed software: Debian packages (including security and kernel updates) and Flathub apps. Read-only.",
			InputSchema: mcp.EmptySchema,
			Risk:        mcp.RiskSafe,
			Call:        d.updatesList,
		},
		{
			Name: "updates.apply",
			Description: "Install updates for the given items (from updates.list). Only upgrades: nothing is newly installed or removed. " +
				"The user confirms on a card first.",
			InputSchema: updatesItemsSchema,
			Risk:        mcp.RiskConfirm,
			Batch:       "items",
			Call:        d.updatesApply,
			Describe:    d.describeUpdates,
		},
	}
}

func (d Deps) updatesList(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	res, err := d.run(ctx, listTimeout, "apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade")
	if err != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "apt-get could not run: %v", err)
	}
	if res.ExitCode != 0 {
		return nil, mcp.Errorf(mcp.CodeFailed, "apt-get reported a problem: %s", lastLines(string(res.Stderr), 5))
	}
	items := []UpdateItem{}
	for _, u := range parse.AptSimUpgrade(string(res.Stdout)) {
		items = append(items, UpdateItem{Source: "apt", ID: u.Name, From: u.From, To: u.To, Security: u.Security})
	}
	items = append(items, d.flatpakUpdates(ctx)...)
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Security != items[j].Security {
			return items[i].Security
		}
		if items[i].Source != items[j].Source {
			return items[i].Source == "apt"
		}
		return items[i].ID < items[j].ID
	})
	d.Updates.store(items)
	return map[string]any{"items": items, "checkedAt": d.now().UTC().Format(time.RFC3339)}, nil
}

// flatpakUpdates lists Flathub app updates. A system without flatpak, or a
// flatpak that cannot reach Flathub, contributes nothing rather than
// hiding the Debian updates.
func (d Deps) flatpakUpdates(ctx context.Context) []UpdateItem {
	upd, err := d.run(ctx, listTimeout, "flatpak", "remote-ls", "--updates", "--system", "--app", "--columns=application,version,origin")
	if err != nil || upd.ExitCode != 0 {
		return nil
	}
	inst, err := d.run(ctx, listTimeout, "flatpak", "list", "--system", "--app", "--columns=application,version,origin")
	from := map[string]string{}
	if err == nil && inst.ExitCode == 0 {
		for _, r := range parse.TabRows(string(inst.Stdout), 3) {
			from[r[0]] = r[1]
		}
	}
	var out []UpdateItem
	for _, r := range parse.TabRows(string(upd.Stdout), 3) {
		if r[2] != "flathub" || validate.FlatpakRef(r[0]) != nil {
			continue
		}
		out = append(out, UpdateItem{Source: "flatpak", ID: r[0], From: from[r[0]], To: r[1]})
	}
	return out
}

func decodeUpdateItems(raw json.RawMessage) ([]pkgRef, error) {
	var in struct {
		Items []pkgRef `json:"items"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if len(in.Items) < 1 || len(in.Items) > validate.MaxUpgradeItems {
		return nil, mcp.Errorf(mcp.CodeInvalid, "items must hold 1 to %d updates", validate.MaxUpgradeItems)
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

// updatesApply upgrades the ticked items: one helper call for all Debian
// packages (apt resolves them together) and one for all Flathub apps. What
// actually changed is read back afterwards (dpkg version, flatpak commit),
// so the result never claims an upgrade that did not happen.
func (d Deps) updatesApply(ctx context.Context, raw json.RawMessage) (any, error) {
	items, err := decodeUpdateItems(raw)
	if err != nil {
		return nil, err
	}
	var apt, flat []string
	for _, it := range items {
		if it.Source == "apt" {
			apt = append(apt, it.ID)
		} else {
			flat = append(flat, it.ID)
		}
	}
	upgraded, failed := []Installed{}, []Failed{}
	if len(apt) > 0 {
		u, f := d.upgradeGroup(ctx, "apt", apt, d.aptVersions, d.Helper.AptUpgrade)
		upgraded, failed = append(upgraded, u...), append(failed, f...)
	}
	if len(flat) > 0 {
		u, f := d.upgradeGroup(ctx, "flatpak", flat, d.flatpakCommits, d.Helper.FlatpakUpdate)
		upgraded, failed = append(upgraded, u...), append(failed, f...)
	}
	return map[string]any{"upgraded": upgraded, "failed": failed}, nil
}

func (d Deps) upgradeGroup(ctx context.Context, source string, ids []string,
	state func(context.Context, []string) map[string]string,
	call func(context.Context, []string) (helperapi.Outcome, error)) ([]Installed, []Failed) {
	var upgraded []Installed
	var failed []Failed
	if ctx.Err() != nil {
		for _, id := range ids {
			failed = append(failed, Failed{source, id, string(mcp.CodeFailed), "stopped before this update was started"})
		}
		return nil, failed
	}
	before := state(ctx, ids)
	// Never cancelled once started: dpkg must not be killed midway.
	out, herr := call(context.WithoutCancel(ctx), ids)
	after := state(context.WithoutCancel(ctx), ids)
	for _, id := range ids {
		if after[id] != "" && after[id] != before[id] {
			v := after[id]
			if source == "flatpak" {
				v = d.installedVersion(context.WithoutCancel(ctx), pkgRef{source, id})
			}
			upgraded = append(upgraded, Installed{Source: source, ID: id, Version: v})
			continue
		}
		failed = append(failed, groupFailure(source, id, out, herr))
	}
	return upgraded, failed
}

func groupFailure(source, id string, out helperapi.Outcome, err error) Failed {
	if err != nil {
		var he *helperapi.Error
		if errors.As(err, &he) {
			return Failed{source, id, he.Code(), he.Error()}
		}
		return Failed{source, id, string(mcp.CodeFailed), err.Error()}
	}
	if !out.OK {
		c := mcp.CodeFailed
		if helperapi.LooksOffline(out.StderrTail) {
			c = mcp.CodeOffline
		}
		return Failed{source, id, string(c), fmt.Sprintf("exit code %d: %s", out.ExitCode, lastLines(out.StderrTail, 5))}
	}
	return Failed{source, id, string(mcp.CodeFailed), "not upgraded: no newer version was available"}
}

// aptVersions returns the installed version of each package ("" if not installed).
func (d Deps) aptVersions(ctx context.Context, names []string) map[string]string {
	res, _ := d.run(ctx, queryTimeout, "dpkg-query", append([]string{"-W", dpkgFormat, "--"}, names...)...)
	out := map[string]string{}
	for _, st := range parse.DpkgQuery(string(res.Stdout)) {
		if st.Installed {
			out[st.Name] = st.Version
		}
	}
	return out
}

// flatpakCommits returns each app's installed commit; flatpak versions often
// stay the same across a rebuild, the commit never does.
func (d Deps) flatpakCommits(ctx context.Context, refs []string) map[string]string {
	out := map[string]string{}
	for _, r := range refs {
		res, err := d.run(ctx, queryTimeout, "flatpak", "info", "--system", "--show-commit", r)
		if err == nil && res.ExitCode == 0 {
			out[r] = strings.TrimSpace(string(res.Stdout))
		}
	}
	return out
}

// describeUpdates builds the card for updates.apply: "Upgrade jarvis-shell
// 0.1.0 → 0.2.0 (Debian, security)". Versions come from the last
// updates.list in this process, else from apt-cache policy / flatpak.
func (d Deps) describeUpdates(ctx context.Context, raw json.RawMessage) (mcp.Description, error) {
	items, err := decodeUpdateItems(raw)
	if err != nil {
		return mcp.Description{}, err
	}
	var titles, lines []string
	for _, it := range items {
		u, ok := d.Updates.get(it)
		if !ok {
			u = d.lookupUpdate(ctx, it)
		}
		title, line := updateText(u)
		titles = append(titles, title)
		lines = append(lines, line)
	}
	title := titles[0]
	if len(items) > 1 {
		ids := make([]string, len(items))
		for i, it := range items {
			ids[i] = it.ID
		}
		title = fmt.Sprintf(cardText.UpgradeMany, len(items), strings.Join(ids, ", "))
	}
	return mcp.Description{Title: title, Detail: strings.Join(lines, "\n"), Source: sourceOf(items[0])}, nil
}

func (d Deps) lookupUpdate(ctx context.Context, it pkgRef) UpdateItem {
	u := UpdateItem{Source: it.Source, ID: it.ID}
	if it.Source == "apt" {
		res, err := d.run(ctx, queryTimeout, "apt-cache", "policy", "--", it.ID)
		if pol := parse.AptCachePolicy(string(res.Stdout)); err == nil && len(pol) > 0 {
			u.From, u.To, u.Security = pol[0].Installed, pol[0].Candidate, pol[0].CandidateSecurity
		}
		return u
	}
	if res, err := d.run(ctx, queryTimeout, "flatpak", "info", "--system", it.ID); err == nil && res.ExitCode == 0 {
		fi, _ := parse.FlatpakDetails(string(res.Stdout))
		u.From = fi.Version
	}
	if res, err := d.run(ctx, queryTimeout, "flatpak", "remote-info", "--system", "flathub", it.ID); err == nil && res.ExitCode == 0 {
		fi, _ := parse.FlatpakDetails(string(res.Stdout))
		u.To = fi.Version
	}
	return u
}

// updateText is the card title and detail line for one update.
func updateText(u UpdateItem) (title, line string) {
	src := cardText.SourceDebian
	if u.Source == "flatpak" {
		src = cardText.SourceFlathub
	}
	where, note := src, ""
	if u.Security {
		where, note = src+cardText.SecuritySuffix, cardText.SecurityNote
	}
	if u.From != "" && u.To != "" && u.From != u.To {
		return fmt.Sprintf(cardText.UpgradeOne, u.ID, u.From, u.To, where),
			fmt.Sprintf(cardText.UpgradeLine, u.ID, u.From, u.To, src, note)
	}
	return fmt.Sprintf(cardText.UpgradeUnknown, u.ID, where), fmt.Sprintf(cardText.UpgradeLineUnknown, u.ID, src, note)
}
