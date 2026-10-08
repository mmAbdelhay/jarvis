package contract

// Pins the Rafiq M3 servers' tools/list output to
// docs/superpowers/specs/2026-10-09-rafiq-m3-contracts.md §1: jarvis-settings
// (settings, users and disks tools), jarvis-apps and the built-in
// jarvis-files. Change the contract file first, then this table.

import (
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/admintools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/apptools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/filestools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/settingstools"
)

type m3want struct {
	risk     string
	hidden   bool
	batch    string
	props    []string
	required []string
	secrets  []string // contracts §5.5: password-tier secret fields
}

var settingsContract = map[string]m3want{
	"settings.get":              {"safe", false, "", []string{"keys"}, nil, nil},
	"settings.brightness":       {"confirm", false, "", []string{"percent"}, []string{"percent"}, nil},
	"settings.volume":           {"confirm", false, "", []string{"muted", "percent"}, nil, nil},
	"settings.night_light":      {"confirm", false, "", []string{"on", "untilHour"}, []string{"on"}, nil},
	"settings.wifi":             {"confirm", false, "", []string{"on"}, []string{"on"}, nil},
	"settings.bluetooth":        {"confirm", false, "", []string{"on"}, []string{"on"}, nil},
	"settings.bluetooth_pair":   {"confirm", false, "", []string{"address"}, []string{"address"}, nil},
	"settings.bluetooth_unpair": {"confirm", false, "", []string{"address"}, []string{"address"}, nil},
	"settings.audio_output":     {"confirm", false, "", []string{"sinkId"}, []string{"sinkId"}, nil},
	"settings.power_profile":    {"confirm", false, "", []string{"profile"}, []string{"profile"}, nil},
	"settings.scale":            {"confirm", false, "", []string{"output", "scale"}, []string{"output", "scale"}, nil},
	"settings.keyboard":         {"confirm", false, "", []string{"layout", "variant"}, []string{"layout"}, nil},
	"users.add":                 {"password", false, "", []string{"adminPassword", "fullName", "newPassword", "username"}, []string{"username"}, []string{"adminPassword", "newPassword"}},
	"users.remove":              {"password", false, "", []string{"adminPassword", "keepHome", "username"}, []string{"username"}, []string{"adminPassword"}},
	"disks.format_removable":    {"password", false, "", []string{"adminPassword", "device", "fs", "label"}, []string{"device", "fs"}, []string{"adminPassword"}},
	"users.list":                {"safe", false, "", nil, nil, nil},
	"disks.list":                {"safe", false, "", nil, nil, nil},
	"disks.mount":               {"confirm", false, "", []string{"device"}, []string{"device"}, nil},
	"disks.unmount":             {"confirm", false, "", []string{"device"}, []string{"device"}, nil},
}

var appsContract = map[string]m3want{
	"apps.list":        {"safe", false, "", []string{"limit", "query"}, nil, nil},
	"apps.windows":     {"safe", false, "", nil, nil, nil},
	"apps.open":        {"safe", false, "", []string{"id", "paths"}, []string{"id"}, nil},
	"apps.focus":       {"safe", false, "", []string{"appId", "windowId"}, nil, nil},
	"apps.close":       {"confirm", false, "", []string{"appId", "windowId"}, nil, nil},
	"apps.open_path":   {"safe", false, "", []string{"target"}, []string{"target"}, nil}, // contracts §5.2: paths under $HOME only
	"apps.open_url":    {"confirm", false, "", []string{"target"}, []string{"target"}, nil},
	"apps.set_default": {"confirm", false, "", []string{"appId", "mimeType"}, []string{"appId", "mimeType"}, nil},
}

var filesContract = map[string]m3want{
	"files.search":     {"safe", false, "", []string{"limit", "path", "query"}, []string{"query"}, nil},
	"files.preview":    {"safe", false, "", []string{"maxBytes", "path"}, []string{"path"}, nil},
	"files.trash_list": {"safe", false, "", []string{"limit", "query"}, nil, nil},
	"files.move":       {"confirm", false, "items", []string{"items"}, []string{"items"}, nil},
	"files.copy":       {"confirm", false, "items", []string{"items"}, []string{"items"}, nil},
	"files.rename":     {"confirm", false, "items", []string{"items"}, []string{"items"}, nil},
	"files.mkdir":      {"confirm", false, "items", []string{"items"}, []string{"items"}, nil},
	"files.trash":      {"confirm", false, "items", []string{"items"}, []string{"items"}, nil},
	"files.restore":    {"confirm", false, "items", []string{"items"}, []string{"items"}, nil},
	"files.undo":       {"confirm", true, "", []string{"journalId"}, []string{"journalId"}, nil},
}

func checkM3(t *testing.T, server string, tools []listedTool, contract map[string]m3want) {
	t.Helper()
	seen := map[string]bool{}
	for _, tl := range tools {
		seen[tl.Name] = true
		m := tl.Meta.Jarvis
		if m.Hidden == nil || m.Secrets == nil {
			t.Errorf("%s %s: _meta.jarvis must carry hidden and secrets explicitly", server, tl.Name)
		}
		if tl.InputSchema.Type != "object" || tl.InputSchema.Additional == nil || *tl.InputSchema.Additional {
			t.Errorf("%s %s: schema must be an object with additionalProperties:false", server, tl.Name)
		}
		if tl.Name == mcp.DescribeTool {
			continue
		}
		w, ok := contract[tl.Name]
		if !ok {
			t.Errorf("%s exposes %s, which is not in the contract", server, tl.Name)
			continue
		}
		var props []string
		for p := range tl.InputSchema.Properties {
			props = append(props, p)
		}
		if m.Risk != w.risk || *m.Hidden != w.hidden || m.Batch != w.batch || !eq(props, w.props) || !eq(tl.InputSchema.Required, w.required) || !eq(m.Secrets, w.secrets) {
			t.Errorf("%s %s: risk=%s hidden=%v batch=%q props=%v required=%v secrets=%v; contract says %+v",
				server, tl.Name, m.Risk, *m.Hidden, m.Batch, props, tl.InputSchema.Required, m.Secrets, w)
		}
	}
	for name := range contract {
		if !seen[name] {
			t.Errorf("%s is missing contract tool %s", server, name)
		}
	}
	if !seen[mcp.DescribeTool] {
		t.Errorf("%s is missing %s", server, mcp.DescribeTool)
	}
}

func TestJarvisSettingsMatchesM3Contract(t *testing.T) {
	tools := append(settingstools.Tools(settingstools.Deps{}), admintools.Tools(admintools.Deps{})...)
	checkM3(t, "jarvis-settings", list(t, &mcp.Server{Name: "jarvis-settings", Tools: tools}), settingsContract)
}

func TestJarvisAppsMatchesM3Contract(t *testing.T) {
	checkM3(t, "jarvis-apps", list(t, &mcp.Server{Name: "jarvis-apps", Tools: apptools.Tools(apptools.Deps{})}), appsContract)
}

func TestBuiltInJarvisFilesMatchesM3Contract(t *testing.T) {
	tools := append(filestools.Tools(filestools.Deps{}), filestools.WriteTools(filestools.WriteDeps{})...)
	checkM3(t, "jarvis-files", list(t, &mcp.Server{Name: "jarvis-files", Tools: tools}), filesContract)
}

// The registry build of jarvis-files (M2.5) must stay read-only: its
// sandbox cannot write, and the index declares only safe tools.
func TestRegistryJarvisFilesStaysReadOnly(t *testing.T) {
	for _, tool := range filestools.Tools(filestools.Deps{}) {
		if tool.Risk != mcp.RiskSafe {
			t.Errorf("registry jarvis-files exposes %s (%s)", tool.Name, tool.Risk)
		}
	}
}
