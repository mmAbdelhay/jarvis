package install

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The install files in os/go/data are hand-written; pin them to the Go
// constants and M2 contracts §1, §7.

func data(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "data", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestInstallerPolicy(t *testing.T) {
	var p struct {
		Actions []struct {
			ID       string `xml:"id,attr"`
			Defaults struct {
				Any      string `xml:"allow_any"`
				Inactive string `xml:"allow_inactive"`
				Active   string `xml:"allow_active"`
			} `xml:"defaults"`
		} `xml:"action"`
	}
	if err := xml.Unmarshal([]byte(data(t, "os.jarvis.installer.policy")), &p); err != nil {
		t.Fatal(err)
	}
	if len(p.Actions) != 1 || p.Actions[0].ID != ActionRun {
		t.Fatalf("actions = %+v", p.Actions)
	}
	if d := p.Actions[0].Defaults; d.Any != "no" || d.Inactive != "no" || d.Active != "yes" {
		t.Fatalf("defaults = %+v (contracts §1: allow_active=yes, others no)", d)
	}
}

func TestInstallerBusFiles(t *testing.T) {
	conf := data(t, "os.jarvis.Installer1.conf")
	if !strings.Contains(conf, `<policy user="root">`+"\n    "+`<allow own="`+BusName+`"/>`) || strings.Count(conf, "allow own=") != 1 {
		t.Fatal("only root may own the installer bus name")
	}
	act := data(t, "os.jarvis.Installer1.service")
	unit := data(t, "jarvis-installer-backend.service")
	for _, want := range []string{"Name=" + BusName, "SystemdService=jarvis-installer-backend.service"} {
		if !strings.Contains(act, want) {
			t.Errorf("activation file lacks %q", want)
		}
	}
	for _, want := range []string{"Type=dbus", "BusName=" + BusName, "ExecStart=/usr/libexec/jarvis/jarvis-installer-backend"} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %q", want)
		}
	}
	if strings.Contains(unit, "[Install]") {
		t.Error("the backend is started by D-Bus activation only")
	}
}

func TestModelFetchUnit(t *testing.T) {
	unit := data(t, "jarvis-model-fetch.service")
	for _, want := range []string{"ConditionPathExists=/var/lib/jarvis/model-pending", "ExecStart=/usr/libexec/jarvis/jarvis-model-fetch",
		"After=network-online.target ollama.service", "ReadWritePaths=/var/lib/jarvis", "IPAddressAllow=localhost", "WantedBy=multi-user.target"} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit lacks %q", want)
		}
	}
	if strings.Contains(unit, "Type=oneshot") {
		t.Error("a oneshot would hold up boot until the download ends")
	}
}
