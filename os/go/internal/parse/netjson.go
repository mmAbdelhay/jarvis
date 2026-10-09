package parse

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// IPAddr is one address of one interface ("192.168.1.10/24").
type IPAddr struct {
	Dev, Addr string
}

// IPAddrs parses `ip -j addr show`, skipping loopback and host-scope addresses.
func IPAddrs(out []byte) ([]IPAddr, error) {
	var links []struct {
		IfName   string `json:"ifname"`
		AddrInfo []struct {
			Local     string `json:"local"`
			PrefixLen int    `json:"prefixlen"`
			Scope     string `json:"scope"`
		} `json:"addr_info"`
	}
	if err := json.Unmarshal(out, &links); err != nil {
		return nil, fmt.Errorf("ip addr: %w", err)
	}
	var res []IPAddr
	for _, l := range links {
		if l.IfName == "lo" {
			continue
		}
		for _, a := range l.AddrInfo {
			if a.Scope == "host" || a.Local == "" {
				continue
			}
			res = append(res, IPAddr{Dev: l.IfName, Addr: a.Local + "/" + strconv.Itoa(a.PrefixLen)})
		}
	}
	return res, nil
}

// Route is the default route.
type Route struct {
	Gateway, Dev string
}

// DefaultRoute parses `ip -j route show default`; nil when there is none.
func DefaultRoute(out []byte) (*Route, error) {
	var routes []struct {
		Gateway string `json:"gateway"`
		Dev     string `json:"dev"`
	}
	if err := json.Unmarshal(out, &routes); err != nil {
		return nil, fmt.Errorf("ip route: %w", err)
	}
	for _, r := range routes {
		if r.Dev != "" {
			return &Route{Gateway: r.Gateway, Dev: r.Dev}, nil
		}
	}
	return nil, nil
}

// Radio is the Wi-Fi rfkill state.
type Radio struct {
	WifiSoftBlocked, WifiHardBlocked bool
}

// Rfkill parses `rfkill --json --output TYPE,SOFT,HARD`. util-linux before
// 2.39 named the top-level array "" instead of "rfkilldevices", so any
// top-level array is read.
func Rfkill(out []byte) (Radio, error) {
	var top map[string][]struct {
		Type string `json:"type"`
		Soft string `json:"soft"`
		Hard string `json:"hard"`
	}
	if err := json.Unmarshal(out, &top); err != nil {
		return Radio{}, fmt.Errorf("rfkill: %w", err)
	}
	var r Radio
	for _, devs := range top {
		for _, d := range devs {
			if d.Type != "wlan" {
				continue
			}
			r.WifiSoftBlocked = r.WifiSoftBlocked || d.Soft == "blocked"
			r.WifiHardBlocked = r.WifiHardBlocked || d.Hard == "blocked"
		}
	}
	return r, nil
}
