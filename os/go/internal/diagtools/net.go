package diagtools

import (
	"context"
	"encoding/json"
	"net"
	"regexp"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/mcp"
	"github.com/mmAbdelhay/jarvis/os/go/internal/parse"
)

// DNSProbeHost is looked up to decide dnsOk; it is also where APT installs
// come from, so "DNS works" means "installs can resolve their mirror".
const DNSProbeHost = "deb.debian.org"

func (d Deps) netTools() []mcp.Tool {
	return []mcp.Tool{
		{
			Name: "net.status",
			Description: "Network state: whether NetworkManager runs, connectivity (full/limited/portal/none/unknown), devices, IP addresses, default route, " +
				"whether DNS resolves, whether the gateway answers ping, and whether Wi-Fi is blocked.",
			InputSchema: mcp.EmptySchema, Risk: mcp.RiskSafe, Call: d.netStatus,
		},
		{
			Name:        "net.wifi_scan",
			Description: "Visible Wi-Fi networks with signal (0-100), security, and whether a saved connection exists for each.",
			InputSchema: mcp.EmptySchema, Risk: mcp.RiskSafe, Call: d.wifiScan,
		},
		{
			Name:        "hw.info",
			Description: "PCI devices with their bound kernel driver (empty = no driver), USB devices, and firmware/driver errors from this boot's kernel log.",
			InputSchema: mcp.EmptySchema, Risk: mcp.RiskSafe, Call: d.hwInfo,
		},
	}
}

type device struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	State      string `json:"state"`
	Connection string `json:"connection"`
}

type ipAddr struct {
	Dev  string `json:"dev"`
	Addr string `json:"addr"`
}

// NetStatus is net.status's result.
type NetStatus struct {
	NMRunning       bool     `json:"nmRunning"`
	Connectivity    string   `json:"connectivity"`
	Devices         []device `json:"devices"`
	IPs             []ipAddr `json:"ips"`
	DefaultRoute    *string  `json:"defaultRoute"`
	DNSOK           bool     `json:"dnsOk"`
	GatewayPingOK   bool     `json:"gatewayPingOk"`
	WifiSoftBlocked bool     `json:"wifiSoftBlocked"`
	WifiHardBlocked bool     `json:"wifiHardBlocked"`
}

// netStatus never fails as a whole: each probe that cannot run leaves its
// field at the pessimistic default, because "I could not tell" is itself
// diagnosis (NetworkManager stopped is the most common case of all).
func (d Deps) netStatus(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	st := NetStatus{Connectivity: "unknown", Devices: []device{}, IPs: []ipAddr{}}

	if res, err := d.run(ctx, queryTimeout, "nmcli", "-t", "-f", "RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI", "general", "status"); err == nil && res.ExitCode == 0 {
		g := parse.NMGeneralStatus(string(res.Stdout))
		st.NMRunning, st.Connectivity = g.Running, g.Connectivity
	}
	if st.NMRunning {
		if res, err := d.run(ctx, queryTimeout, "nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"); err == nil {
			for _, dv := range parse.NMDevices(string(res.Stdout)) {
				st.Devices = append(st.Devices, device{dv.Name, dv.Type, dv.State, dv.Connection})
			}
		}
	}
	if res, err := d.run(ctx, queryTimeout, "ip", "-j", "addr", "show"); err == nil {
		if addrs, err := parse.IPAddrs(res.Stdout); err == nil {
			for _, a := range addrs {
				st.IPs = append(st.IPs, ipAddr{a.Dev, a.Addr})
			}
		}
	}
	var gateway string
	if res, err := d.run(ctx, queryTimeout, "ip", "-j", "route", "show", "default"); err == nil {
		if r, err := parse.DefaultRoute(res.Stdout); err == nil && r != nil && r.Gateway != "" {
			s := r.Gateway + " dev " + r.Dev
			st.DefaultRoute = &s
			gateway = r.Gateway
		}
	}
	if d.Resolver != nil {
		lctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		addrs, err := d.Resolver.LookupHost(lctx, DNSProbeHost)
		cancel()
		st.DNSOK = err == nil && len(addrs) > 0
	}
	// Only an address parsed as an IP ever reaches ping's argv.
	if ip := net.ParseIP(gateway); ip != nil {
		res, err := d.run(ctx, 5*time.Second, "ping", "-n", "-c", "1", "-W", "2", "--", ip.String())
		st.GatewayPingOK = err == nil && res.ExitCode == 0
	}
	if res, err := d.run(ctx, queryTimeout, "rfkill", "--json", "--output", "TYPE,SOFT,HARD"); err == nil && res.ExitCode == 0 {
		if r, err := parse.Rfkill(res.Stdout); err == nil {
			st.WifiSoftBlocked, st.WifiHardBlocked = r.WifiSoftBlocked, r.WifiHardBlocked
		}
	}
	return st, nil
}

type network struct {
	SSID     string `json:"ssid"`
	Signal   int    `json:"signal"`
	Security string `json:"security"`
	Known    bool   `json:"known"`
}

func (d Deps) wifiScan(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	res, err := d.run(ctx, 30*time.Second, "nmcli", "-t", "-f", "IN-USE,SSID,SIGNAL,SECURITY", "device", "wifi", "list", "--rescan", "auto")
	if err != nil || res.ExitCode != 0 {
		return nil, nmError(res.ExitCode, err)
	}
	known := map[string]bool{}
	if cr, err := d.run(ctx, queryTimeout, "nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"); err == nil {
		for _, c := range parse.NMConnections(string(cr.Stdout)) {
			if c.Type == "802-11-wireless" {
				known[c.Name] = true // NetworkManager names Wi-Fi profiles after the SSID by default
			}
		}
	}
	nets := []network{}
	for _, n := range parse.NMWifiList(string(res.Stdout)) {
		nets = append(nets, network{n.SSID, n.Signal, n.Security, known[n.SSID]})
	}
	return map[string]any{"networks": nets}, nil
}

// nmError maps nmcli's documented exit codes to tool errors.
func nmError(exit int, err error) error {
	switch {
	case err != nil:
		return mcp.Errorf(mcp.CodeFailed, "nmcli could not run: %v", err)
	case exit == 8:
		return mcp.Errorf(mcp.CodeFailed, "NetworkManager is not running")
	case exit == 10:
		return mcp.Errorf(mcp.CodeNotFound, "no such connection, device or network")
	case exit == 3:
		return mcp.Errorf(mcp.CodeFailed, "timed out waiting for the network")
	case exit == 4:
		return mcp.Errorf(mcp.CodeFailed, "the connection could not be activated (wrong password, or the network refused it)")
	}
	return mcp.Errorf(mcp.CodeFailed, "nmcli failed with exit code %d", exit)
}

type pci struct {
	Slot   string `json:"slot"`
	Name   string `json:"name"`
	Driver string `json:"driver"`
}

type usb struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// firmwareRe picks kernel messages that point at a missing driver or firmware.
var firmwareRe = regexp.MustCompile(`(?i)firmware|failed to load|probe .*failed|no driver|unsupported device`)

func (d Deps) hwInfo(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := mcp.DecodeArgs(raw, &struct{}{}); err != nil {
		return nil, err
	}
	out := struct {
		PCI            []pci    `json:"pci"`
		USB            []usb    `json:"usb"`
		FirmwareErrors []string `json:"firmwareErrors"`
	}{PCI: []pci{}, USB: []usb{}, FirmwareErrors: []string{}}
	if res, err := d.run(ctx, queryTimeout, "lspci", "-k"); err == nil {
		for _, p := range parse.LspciK(string(res.Stdout)) {
			out.PCI = append(out.PCI, pci{p.Slot, p.Name, p.Driver})
		}
	}
	if res, err := d.run(ctx, queryTimeout, "lsusb"); err == nil {
		for _, u := range parse.Lsusb(string(res.Stdout)) {
			out.USB = append(out.USB, usb{u.ID, u.Name})
		}
	}
	if res, err := d.run(ctx, queryTimeout, "journalctl", "-k", "-b", "-q", "--no-pager", "-o", "json", "-p", "4", "-n", "2000"); err == nil {
		seen := map[string]bool{}
		for _, e := range parse.Journal(string(res.Stdout)) {
			if firmwareRe.MatchString(e.Message) && !seen[e.Message] && len(out.FirmwareErrors) < 20 {
				seen[e.Message] = true
				out.FirmwareErrors = append(out.FirmwareErrors, e.Message)
			}
		}
	}
	return out, nil
}
