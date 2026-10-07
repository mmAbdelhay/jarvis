package parse

import (
	"reflect"
	"testing"
)

func TestTerse(t *testing.T) {
	if got := Terse(`a\:b:c\\d::`); !reflect.DeepEqual(got, []string{"a:b", `c\d`, "", ""}) {
		t.Fatalf("got %q", got)
	}
}

func TestNMGeneralStatus(t *testing.T) {
	got := NMGeneralStatus(fixture(t, "nmcli-general.txt"))
	want := NMGeneral{Running: true, State: "connected (local only)", Connectivity: "limited", WifiHW: "enabled", Wifi: "disabled"}
	if got != want {
		t.Fatalf("got %+v", got)
	}
	if NMGeneralStatus("").Connectivity != "unknown" || NMGeneralStatus("running:x:weird:enabled:enabled").Connectivity != "unknown" {
		t.Fatal("unknown connectivity must normalise to \"unknown\"")
	}
}

func TestNMDevices(t *testing.T) {
	got := NMDevices(fixture(t, "nmcli-device-status.txt"))
	want := []NMDevice{{"enp1s0", "ethernet", "connected", "Wired connection 1"}, {"wlp2s0", "wifi", "disconnected", ""}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestNMWifiList(t *testing.T) {
	got := NMWifiList(fixture(t, "nmcli-wifi-list.txt"))
	want := []WifiNetwork{
		{SSID: "Home", Signal: 82, Security: "WPA2", InUse: true},
		{SSID: "Office 5G", Signal: 67, Security: "WPA2 WPA3"},
		{SSID: "Cafe: Free WiFi", Signal: 54, Security: "open"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestNMConnections(t *testing.T) {
	got := NMConnections(fixture(t, "nmcli-connections.txt"))
	if len(got) != 3 || got[1] != (NMConnection{"Home", "802-11-wireless"}) {
		t.Fatalf("got %+v", got)
	}
}

func TestIPAddrsAndDefaultRoute(t *testing.T) {
	addrs, err := IPAddrs(fixtureBytes(t, "ip-addr.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := []IPAddr{{"enp1s0", "192.168.122.50/24"}, {"enp1s0", "fe80::5054:ff:fe12:3456/64"}}
	if !reflect.DeepEqual(addrs, want) {
		t.Fatalf("addrs = %+v", addrs)
	}
	r, err := DefaultRoute(fixtureBytes(t, "ip-route-default.json"))
	if err != nil || r == nil || *r != (Route{"192.168.122.1", "enp1s0"}) {
		t.Fatalf("route = %+v, %v", r, err)
	}
	if r, err := DefaultRoute([]byte("[]")); r != nil || err != nil {
		t.Fatalf("no route must be nil, nil; got %+v %v", r, err)
	}
}

func TestRfkill(t *testing.T) {
	r, err := Rfkill(fixtureBytes(t, "rfkill.json"))
	if err != nil || r != (Radio{WifiSoftBlocked: true}) {
		t.Fatalf("got %+v, %v", r, err)
	}
	old := []byte(`{"": [{"type":"wlan","soft":"unblocked","hard":"blocked"}]}`)
	if r, err := Rfkill(old); err != nil || r != (Radio{WifiHardBlocked: true}) {
		t.Fatalf("pre-2.39 format: %+v, %v", r, err)
	}
}

func TestLspciK(t *testing.T) {
	got := LspciK(fixture(t, "lspci-k.txt"))
	if len(got) != 4 {
		t.Fatalf("got %d devices", len(got))
	}
	if got[1] != (PCIDevice{"00:01.0", "VGA compatible controller: Device 1234:1111 (rev 02)", "bochs-drm"}) {
		t.Errorf("vga = %+v", got[1])
	}
	if got[3].Driver != "" || got[3].Slot != "02:00.0" {
		t.Errorf("wifi with module but no bound driver = %+v", got[3])
	}
}

func TestLsusb(t *testing.T) {
	got := Lsusb(fixture(t, "lsusb.txt"))
	if len(got) != 4 || got[2] != (USBDevice{"8087:0033", "Intel Corp. AX211 Bluetooth"}) || got[3] != (USBDevice{"0bda:5634", ""}) {
		t.Fatalf("got %+v", got)
	}
}
