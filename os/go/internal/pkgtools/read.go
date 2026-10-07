package pkgtools

import (
	"context"
	"encoding/json"
	"io/fs"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
	"github.com/mmAbdelhay/jarvis/os/go/internal/validate"
)

const dpkgFormat = "-f=${Package}\t${Version}\t${db:Status-Status}\n"

func (d Deps) run(ctx context.Context, timeout time.Duration, name string, args ...string) (execx.Result, error) {
	return d.Run.Run(ctx, execx.Cmd{Name: name, Args: args, Timeout: timeout})
}

// SearchResult is one pkg.search hit.
type SearchResult struct {
	Source  string `json:"source"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
	Summary string `json:"summary"`
	rank    int
}

func (d Deps) search(ctx context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		Query string `json:"query"`
		Limit *int   `json:"limit"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	query := strings.TrimSpace(in.Query)
	if query == "" || utf8.RuneCountInString(query) > 100 || strings.IndexFunc(query, unicode.IsControl) >= 0 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "query must be 1-100 characters of text")
	}
	limit := 20
	if in.Limit != nil {
		if *in.Limit < 1 || *in.Limit > 50 {
			return nil, mcp.Errorf(mcp.CodeInvalid, "limit must be 1-50")
		}
		limit = *in.Limit
	}
	words := strings.Fields(strings.ToLower(query))
	if len(words) > 5 {
		words = words[:5]
	}

	aptHits, aptErr := d.searchApt(ctx, words, limit)
	flatHits, flatErr := d.searchFlatpak(ctx, query)
	if aptErr != nil && flatErr != nil {
		return nil, mcp.Errorf(mcp.CodeFailed, "search failed: %v; %v", aptErr, flatErr)
	}
	all := append(aptHits, flatHits...)
	// Exact id/name matches first; on a tie APT before Flathub (design §6.1:
	// prefer APT when the app exists there); otherwise keep each source's order.
	sort.SliceStable(all, func(i, j int) bool { return all[i].rank < all[j].rank })
	if len(all) > limit {
		all = all[:limit]
	}
	if all == nil {
		all = []SearchResult{}
	}
	return map[string]any{"results": all}, nil
}

func rankOf(words []string, id, name string) int {
	q := strings.Join(words, " ")
	id, name = strings.ToLower(id), strings.ToLower(name)
	switch {
	case id == q || name == q || strings.HasSuffix(id, "."+q):
		return 0
	case strings.HasPrefix(id, q) || strings.HasPrefix(name, q):
		return 2
	case strings.Contains(id, q) || strings.Contains(name, q):
		return 4
	default:
		return 6
	}
}

func (d Deps) searchApt(ctx context.Context, words []string, limit int) ([]SearchResult, error) {
	// apt-cache search treats each term as a POSIX regex; quote them so
	// "c++" or ".*" are searched literally. "--" stops option parsing.
	args := []string{"search", "--"}
	for _, w := range words {
		args = append(args, regexp.QuoteMeta(w))
	}
	res, err := d.run(ctx, queryTimeout, "apt-cache", args...)
	if err != nil {
		return nil, err
	}
	hits := parse.AptSearch(string(res.Stdout))
	out := make([]SearchResult, 0, len(hits))
	for _, h := range hits {
		out = append(out, SearchResult{Source: "apt", ID: h.Name, Name: h.Name, Summary: h.Summary, rank: rankOf(words, h.Name, h.Name)})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].rank < out[j].rank })
	if len(out) > limit {
		out = out[:limit]
	}
	if len(out) == 0 {
		return out, nil
	}
	// One apt-cache show for the survivors fills in versions.
	showArgs := []string{"show", "--no-all-versions", "--"}
	for _, r := range out {
		showArgs = append(showArgs, r.ID)
	}
	if show, err := d.run(ctx, queryTimeout, "apt-cache", showArgs...); err == nil {
		versions := map[string]string{}
		for _, p := range parse.AptShow(string(show.Stdout)) {
			versions[p.Name] = p.Version
		}
		for i := range out {
			out[i].Version = versions[out[i].ID]
		}
	}
	return out, nil
}

func (d Deps) searchFlatpak(ctx context.Context, query string) ([]SearchResult, error) {
	res, err := d.run(ctx, queryTimeout, "flatpak", "search", "--columns=application,name,version,description,remotes", "--", query)
	if err != nil {
		return nil, err
	}
	words := strings.Fields(strings.ToLower(query))
	var out []SearchResult
	for _, h := range parse.FlatpakSearch(string(res.Stdout)) {
		onFlathub := false
		for _, r := range h.Remotes {
			onFlathub = onFlathub || r == "flathub"
		}
		if !onFlathub || validate.FlatpakRef(h.ID) != nil {
			continue
		}
		// +1: on an equal match APT sorts first.
		out = append(out, SearchResult{Source: "flatpak", ID: h.ID, Name: h.Name, Version: h.Version, Summary: h.Summary, rank: rankOf(words, h.ID, h.Name) + 1})
	}
	return out, nil
}

// pkgRef is the {source, id} pair every pkg tool takes.
type pkgRef struct {
	Source string `json:"source"`
	ID     string `json:"id"`
}

func (r pkgRef) check() error {
	switch r.Source {
	case "apt":
		if err := validate.AptName(r.ID); err != nil {
			return mcp.Errorf(mcp.CodeInvalid, "%v", err)
		}
	case "flatpak":
		if err := validate.FlatpakRef(r.ID); err != nil {
			return mcp.Errorf(mcp.CodeInvalid, "%v", err)
		}
	default:
		return mcp.Errorf(mcp.CodeInvalid, "source must be \"apt\" or \"flatpak\"")
	}
	return nil
}

// Info is pkg.info's result.
type Info struct {
	Source         string `json:"source"`
	ID             string `json:"id"`
	Name           string `json:"name"`
	Version        string `json:"version"`
	DownloadBytes  int64  `json:"downloadBytes"`
	InstalledBytes int64  `json:"installedBytes"`
	Summary        string `json:"summary"`
	Installed      bool   `json:"installed"`
}

func (d Deps) info(ctx context.Context, raw json.RawMessage) (any, error) {
	var in pkgRef
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if err := in.check(); err != nil {
		return nil, err
	}
	return d.lookup(ctx, in)
}

// lookup is shared by pkg.info and the install/remove card descriptions.
func (d Deps) lookup(ctx context.Context, in pkgRef) (Info, error) {
	if in.Source == "apt" {
		res, err := d.run(ctx, queryTimeout, "apt-cache", "show", "--no-all-versions", "--", in.ID)
		pkgs := parse.AptShow(string(res.Stdout))
		if err != nil || len(pkgs) == 0 {
			return Info{}, mcp.Errorf(mcp.CodeNotFound, "%s is not in Debian", in.ID)
		}
		p := pkgs[0]
		st, _ := d.run(ctx, queryTimeout, "dpkg-query", "-W", dpkgFormat, "--", in.ID)
		statuses := parse.DpkgQuery(string(st.Stdout))
		return Info{Source: "apt", ID: in.ID, Name: p.Name, Version: p.Version, DownloadBytes: p.DownloadBytes,
			InstalledBytes: p.InstalledBytes, Summary: p.Summary, Installed: len(statuses) > 0 && statuses[0].Installed}, nil
	}
	res, err := d.run(ctx, queryTimeout, "flatpak", "remote-info", "--system", "flathub", in.ID)
	if err != nil {
		return Info{}, mcp.Errorf(mcp.CodeFailed, "flatpak: %v", err)
	}
	if res.ExitCode != 0 {
		if helperapi.LooksOffline(string(res.Stderr)) {
			return Info{}, mcp.Errorf(mcp.CodeOffline, "Flathub cannot be reached: the computer seems to be offline")
		}
		return Info{}, mcp.Errorf(mcp.CodeNotFound, "%s is not on Flathub", in.ID)
	}
	fi, err := parse.FlatpakDetails(string(res.Stdout))
	if err != nil {
		return Info{}, mcp.Errorf(mcp.CodeFailed, "unexpected flatpak output")
	}
	inst, _ := d.run(ctx, queryTimeout, "flatpak", "info", in.ID)
	return Info{Source: "flatpak", ID: in.ID, Name: fi.Name, Version: fi.Version, DownloadBytes: fi.DownloadBytes,
		InstalledBytes: fi.InstalledBytes, Summary: fi.Summary, Installed: inst.ExitCode == 0}, nil
}

// App is one pkg.list_installed entry.
type App struct {
	Source  string `json:"source"`
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

func (d Deps) listInstalled(ctx context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		Source string `json:"source"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	if in.Source != "" && in.Source != "apt" && in.Source != "flatpak" {
		return nil, mcp.Errorf(mcp.CodeInvalid, "source must be \"apt\" or \"flatpak\"")
	}
	apps := []App{}
	if in.Source != "flatpak" {
		apps = append(apps, d.aptApps(ctx)...)
	}
	if in.Source != "apt" {
		if res, err := d.run(ctx, queryTimeout, "flatpak", "list", "--app", "--columns=application,name,version"); err == nil && res.ExitCode == 0 {
			for _, a := range parse.FlatpakList(string(res.Stdout)) {
				apps = append(apps, App{Source: "flatpak", ID: a.ID, Name: a.Name, Version: a.Version})
			}
		}
	}
	sort.SliceStable(apps, func(i, j int) bool { return strings.ToLower(apps[i].Name) < strings.ToLower(apps[j].Name) })
	return map[string]any{"apps": apps}, nil
}

// aptApps lists APT packages that own a visible .desktop launcher.
func (d Deps) aptApps(ctx context.Context) []App {
	files, _ := fs.Glob(d.FS, "usr/share/applications/*.desktop")
	names := map[string]string{} // absolute path → launcher name
	var paths []string
	for _, f := range files {
		b, err := fs.ReadFile(d.FS, f)
		if err != nil {
			continue
		}
		if e := parse.Desktop(string(b)); e.Visible() {
			p := "/" + f
			names[p] = e.Name
			paths = append(paths, p)
		}
	}
	if len(paths) == 0 {
		return nil
	}
	// dpkg-query -S exits 1 when some path has no owner but still prints the
	// owners it found, so stdout is used regardless of the exit code.
	owners, err := d.run(ctx, queryTimeout, "dpkg-query", append([]string{"-S", "--"}, paths...)...)
	if err != nil {
		return nil
	}
	pkgName := map[string]string{}
	var pkgs []string
	for _, p := range paths {
		for _, pkg := range parse.DpkgSearch(string(owners.Stdout))[p] {
			if _, seen := pkgName[pkg]; !seen {
				pkgName[pkg] = names[p]
				pkgs = append(pkgs, pkg)
			}
			break // first owner is the app package
		}
	}
	if len(pkgs) == 0 {
		return nil
	}
	st, err := d.run(ctx, queryTimeout, "dpkg-query", append([]string{"-W", dpkgFormat, "--"}, pkgs...)...)
	if err != nil {
		return nil
	}
	var apps []App
	for _, s := range parse.DpkgQuery(string(st.Stdout)) {
		if s.Installed {
			apps = append(apps, App{Source: "apt", ID: s.Name, Name: pkgName[s.Name], Version: s.Version})
		}
	}
	return apps
}

func (d Deps) diskUsage(ctx context.Context, raw json.RawMessage) (any, error) {
	var in struct {
		Path string `json:"path"`
	}
	if err := mcp.DecodeArgs(raw, &in); err != nil {
		return nil, err
	}
	p := in.Path
	if p == "" {
		p = d.Home
	}
	if !path.IsAbs(p) || strings.ContainsRune(p, 0) || len(p) > 4096 {
		return nil, mcp.Errorf(mcp.CodeInvalid, "path must be absolute")
	}
	p = path.Clean(p)
	rel := strings.TrimPrefix(p, "/")
	if rel == "" {
		rel = "."
	}
	if st, err := fs.Stat(d.FS, rel); err != nil || !st.IsDir() {
		return nil, mcp.Errorf(mcp.CodeNotFound, "%s is not a directory", p)
	}

	type fsUse struct {
		Mount     string `json:"mount"`
		SizeBytes int64  `json:"sizeBytes"`
		UsedBytes int64  `json:"usedBytes"`
	}
	type dirUse struct {
		Path  string `json:"path"`
		Bytes int64  `json:"bytes"`
	}
	out := struct {
		Filesystems []fsUse  `json:"filesystems"`
		Largest     []dirUse `json:"largest"`
	}{Filesystems: []fsUse{}, Largest: []dirUse{}}

	if res, err := d.run(ctx, queryTimeout, "df", parse.DfArgs...); err == nil {
		for _, f := range parse.Df(string(res.Stdout)) {
			out.Filesystems = append(out.Filesystems, fsUse{f.Mount, f.SizeBytes, f.UsedBytes})
		}
	}
	// du exits 1 when it could not read some directory but still prints the
	// rest; partial sizes are better than none.
	res, err := d.run(ctx, 60*time.Second, "du", "-x", "-B1", "-d", "1", "--", p)
	if err == nil && (res.ExitCode == 0 || len(res.Stdout) > 0) {
		for _, ds := range parse.Du(string(res.Stdout), p, 10) {
			out.Largest = append(out.Largest, dirUse{ds.Path, ds.Bytes})
		}
	}
	return out, nil
}
