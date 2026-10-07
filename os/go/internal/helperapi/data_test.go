package helperapi

import (
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The install files in os/go/data are hand-written; these tests pin them to
// the Go constants and to contracts §2 so the two cannot drift apart.

func readData(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "data", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestPolkitPolicyMatchesContract(t *testing.T) {
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
	if err := xml.Unmarshal(readData(t, "os.jarvis.helper.policy"), &p); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{ActionPackages: "yes", ActionServices: "yes", ActionAdmin: "auth_admin_keep"}
	if len(p.Actions) != len(want) {
		t.Fatalf("got %d actions, want %d", len(p.Actions), len(want))
	}
	for _, a := range p.Actions {
		active, ok := want[a.ID]
		if !ok {
			t.Errorf("unexpected action %q", a.ID)
			continue
		}
		if a.Defaults.Any != "no" || a.Defaults.Inactive != "no" || a.Defaults.Active != active {
			t.Errorf("%s defaults = %+v, want any=no inactive=no active=%s", a.ID, a.Defaults, active)
		}
	}
}

func TestBusPolicyLetsOnlyRootOwnTheName(t *testing.T) {
	type rule struct {
		Own           string `xml:"own,attr"`
		SendDest      string `xml:"send_destination,attr"`
		SendInterface string `xml:"send_interface,attr"`
	}
	var c struct {
		Policies []struct {
			User    string `xml:"user,attr"`
			Context string `xml:"context,attr"`
			Allow   []rule `xml:"allow"`
		} `xml:"policy"`
	}
	if err := xml.Unmarshal(readData(t, "os.jarvis.Helper1.conf"), &c); err != nil {
		t.Fatal(err)
	}
	var rootOwns, defaultSends bool
	for _, p := range c.Policies {
		for _, a := range p.Allow {
			if a.Own == BusName && p.User != "root" {
				t.Errorf("policy %+v lets a non-root user own %s", p, BusName)
			}
			if a.Own == BusName && p.User == "root" {
				rootOwns = true
			}
			if p.Context == "default" && a.SendDest == BusName && a.SendInterface == Interface {
				defaultSends = true
			}
			if p.Context == "default" && a.SendDest == BusName && a.SendInterface == "" {
				t.Errorf("default policy allows every interface on %s", BusName)
			}
		}
	}
	if !rootOwns || !defaultSends {
		t.Fatalf("rootOwns=%v defaultSends=%v", rootOwns, defaultSends)
	}
}

func keyValues(b []byte) map[string]string {
	kv := map[string]string{}
	for _, line := range strings.Split(string(b), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok && !strings.HasPrefix(line, "#") {
			kv[k] = v
		}
	}
	return kv
}

func TestActivationAndUnitFilesAgree(t *testing.T) {
	svc := keyValues(readData(t, "os.jarvis.Helper1.service"))
	if svc["Name"] != BusName || svc["SystemdService"] != "jarvis-helper.service" || svc["User"] != "root" {
		t.Fatalf("activation file = %v", svc)
	}
	unit := keyValues(readData(t, "jarvis-helper.service"))
	if unit["Type"] != "dbus" || unit["BusName"] != BusName || unit["ExecStart"] != "/usr/libexec/jarvis/jarvis-helper" {
		t.Fatalf("unit file = %v", unit)
	}
}

func TestErrorCodes(t *testing.T) {
	for name, code := range map[string]string{ErrInvalid: "invalid", ErrNotFound: "not_found", ErrDenied: "denied", ErrNotAllowed: "not_allowed", "org.freedesktop.DBus.Error.ServiceUnknown": "failed", "": "failed"} {
		if got := (&Error{Name: name}).Code(); got != code {
			t.Errorf("Code(%q) = %q, want %q", name, got, code)
		}
	}
}

func TestLooksOffline(t *testing.T) {
	if !LooksOffline("W: Failed to fetch http://deb.debian.org/...  Temporary failure resolving 'deb.debian.org'") {
		t.Error("apt offline message not recognised")
	}
	if LooksOffline("E: Unable to locate package nope") {
		t.Error("not-found message treated as offline")
	}
}
