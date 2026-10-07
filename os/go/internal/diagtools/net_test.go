package diagtools

import (
	"context"
	"errors"
	"testing"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
)

type fakeResolver struct{ err error }

func (f fakeResolver) LookupHost(context.Context, string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return []string{"151.101.2.132"}, nil
}

func healthyNet(t *testing.T) *execx.Fake {
	return (&execx.Fake{}).
		On(execx.OK("running:connected:full:enabled:enabled\n"), "nmcli", "-t", "-f", "RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI", "general", "status").
		On(execx.Result{Stdout: fixture(t, "nmcli-device-status.txt")}, "nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status").
		On(execx.Result{Stdout: fixture(t, "ip-addr.json")}, "ip", "-j", "addr", "show").
		On(execx.Result{Stdout: fixture(t, "ip-route-default.json")}, "ip", "-j", "route", "show", "default").
		On(execx.OK(""), "ping", "-n", "-c", "1", "-W", "2", "--", "192.168.122.1").
		On(execx.Result{Stdout: fixture(t, "rfkill.json")}, "rfkill", "--json", "--output", "TYPE,SOFT,HARD")
}

func TestNetStatusHealthy(t *testing.T) {
	v, err := call(t, Deps{Run: healthyNet(t), Resolver: fakeResolver{}}, "net.status", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	st := v.(NetStatus)
	if !st.NMRunning || st.Connectivity != "full" || len(st.Devices) != 2 || len(st.IPs) != 2 {
		t.Errorf("got %+v", st)
	}
	if st.DefaultRoute == nil || *st.DefaultRoute != "192.168.122.1 dev enp1s0" || !st.DNSOK || !st.GatewayPingOK {
		t.Errorf("route/dns/ping = %v %v %v", st.DefaultRoute, st.DNSOK, st.GatewayPingOK)
	}
	if !st.WifiSoftBlocked || st.WifiHardBlocked {
		t.Errorf("rfkill = soft %v hard %v", st.WifiSoftBlocked, st.WifiHardBlocked)
	}
}

// The single most common M1 case: NetworkManager stopped. net.status must
// still answer, with nmRunning=false, not fail.
func TestNetStatusWithNetworkManagerStopped(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.Exit(8, "Error: NetworkManager is not running.\n"), "nmcli", "-t", "-f", "RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI", "general", "status").
		On(execx.OK(`[{"ifname":"lo","addr_info":[]}]`), "ip", "-j", "addr", "show").
		On(execx.OK("[]"), "ip", "-j", "route", "show", "default").
		On(execx.OK(`{"rfkilldevices":[]}`), "rfkill", "--json", "--output", "TYPE,SOFT,HARD")
	v, err := call(t, Deps{Run: run, Resolver: fakeResolver{err: errors.New("no such host")}}, "net.status", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, v)
	if m["nmRunning"] != false || m["connectivity"] != "unknown" || m["defaultRoute"] != nil || m["dnsOk"] != false || m["gatewayPingOk"] != false {
		t.Fatalf("got %v", m)
	}
	if run.Ran("nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status") {
		t.Error("device status queried although NetworkManager is down")
	}
}

func TestWifiScan(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.Result{Stdout: fixture(t, "nmcli-wifi-list.txt")}, "nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto").
		On(execx.Result{Stdout: fixture(t, "nmcli-connections.txt")}, "nmcli", "-t", "-f", "NAME,TYPE", "connection", "show")
	v, err := call(t, Deps{Run: run}, "net.wifi_scan", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	nets := asJSON(t, v)["networks"].([]any)
	if len(nets) != 3 {
		t.Fatalf("networks = %v", nets)
	}
	home, cafe := nets[0].(map[string]any), nets[2].(map[string]any)
	if home["ssid"] != "Home" || home["known"] != true || cafe["ssid"] != "Cafe: Free WiFi" || cafe["known"] != false || cafe["security"] != "open" {
		t.Fatalf("got %v / %v", home, cafe)
	}
	stopped := (&execx.Fake{}).On(execx.Exit(8, "Error: NetworkManager is not running."), "nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto")
	if _, err := call(t, Deps{Run: stopped}, "net.wifi_scan", `{}`); code(err) != mcp.CodeFailed {
		t.Fatalf("NM stopped: %v", err)
	}
}

func TestHwInfo(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.Result{Stdout: fixture(t, "lspci-k.txt")}, "lspci", "-k").
		On(execx.Result{Stdout: fixture(t, "lsusb.txt")}, "lsusb").
		On(execx.Result{Stdout: fixture(t, "journal.json")}, "journalctl", "-k", "-b", "-q", "--no-pager", "-o", "json", "-p", "4", "-n", "2000")
	v, err := call(t, Deps{Run: run}, "hw.info", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	m := asJSON(t, v)
	if len(m["pci"].([]any)) != 4 || len(m["usb"].([]any)) != 4 {
		t.Fatalf("pci/usb = %v", m)
	}
	fw := m["firmwareErrors"].([]any)
	if len(fw) != 1 || fw[0] != "iwlwifi 0000:02:00.0: Direct firmware load for iwlwifi-so-a0-gf-a0-89.ucode failed with error -2" {
		t.Fatalf("firmwareErrors = %v", fw)
	}
}

func TestNetStatusRouteWithoutGateway(t *testing.T) {
	run := (&execx.Fake{}).
		On(execx.OK(`[{"dev":"enp1s0"}]`), "ip", "-j", "route", "show", "default")
	v, err := call(t, Deps{Run: run}, "net.status", `{}`)
	if err != nil {
		t.Fatal(err)
	}
	if st := v.(NetStatus); st.DefaultRoute != nil || st.GatewayPingOK {
		t.Fatalf("route without gateway = %+v", st)
	}
}
