package parse

import (
	"sort"
	"strconv"
	"strings"
)

// Terse splits one `nmcli -t` line on unescaped ':' and unescapes "\:" and
// "\\". An SSID like "Cafe: Free WiFi" arrives as "Cafe\: Free WiFi".
func Terse(line string) []string {
	var (
		fields []string
		cur    strings.Builder
	)
	for i := 0; i < len(line); i++ {
		c := line[i]
		switch {
		case c == '\\' && i+1 < len(line):
			i++
			cur.WriteByte(line[i])
		case c == ':':
			fields = append(fields, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(c)
		}
	}
	return append(fields, cur.String())
}

func terseLines(out string, want int) [][]string {
	var res [][]string
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if f := Terse(line); len(f) >= want {
			res = append(res, f)
		}
	}
	return res
}

// NMGeneral is `nmcli -t -f RUNNING,STATE,CONNECTIVITY,WIFI-HW,WIFI general status`.
type NMGeneral struct {
	Running      bool
	State        string
	Connectivity string // full | limited | portal | none | unknown
	WifiHW       string // enabled | disabled | missing
	Wifi         string // enabled | disabled
}

// NMGeneralStatus parses the one-line terse general status.
func NMGeneralStatus(out string) NMGeneral {
	rows := terseLines(out, 5)
	if len(rows) == 0 {
		return NMGeneral{Connectivity: "unknown"}
	}
	f := rows[0]
	g := NMGeneral{Running: f[0] == "running", State: f[1], Connectivity: f[2], WifiHW: f[3], Wifi: f[4]}
	switch g.Connectivity {
	case "full", "limited", "portal", "none", "unknown":
	default:
		g.Connectivity = "unknown"
	}
	return g
}

// NMDevice is one row of `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`.
type NMDevice struct {
	Name, Type, State, Connection string
}

// NMDevices parses device rows, dropping loopback and Wi-Fi P2P pseudo-devices.
func NMDevices(out string) []NMDevice {
	var res []NMDevice
	for _, f := range terseLines(out, 4) {
		if f[1] == "loopback" || f[1] == "wifi-p2p" {
			continue
		}
		conn := f[3]
		if conn == "--" {
			conn = ""
		}
		res = append(res, NMDevice{Name: f[0], Type: f[1], State: f[2], Connection: conn})
	}
	return res
}

// WifiNetwork is one visible network.
type WifiNetwork struct {
	SSID     string
	Signal   int
	Security string
	InUse    bool
}

// NMWifiList parses `nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list`.
// Hidden networks (empty SSID) are dropped, an SSID seen on several access
// points is kept once with its strongest signal, and the list is sorted by
// signal, strongest first.
func NMWifiList(out string) []WifiNetwork {
	best := map[string]WifiNetwork{}
	for _, f := range terseLines(out, 4) {
		ssid := f[1]
		if ssid == "" {
			continue
		}
		sig, _ := strconv.Atoi(f[2])
		sec := strings.TrimSpace(f[3])
		if sec == "" || sec == "--" {
			sec = "open"
		}
		n := WifiNetwork{SSID: ssid, Signal: sig, Security: sec, InUse: strings.TrimSpace(f[0]) == "*"}
		if old, ok := best[ssid]; !ok || n.Signal > old.Signal {
			n.InUse = n.InUse || old.InUse
			best[ssid] = n
		} else if n.InUse {
			old.InUse = true
			best[ssid] = old
		}
	}
	res := make([]WifiNetwork, 0, len(best))
	for _, n := range best {
		res = append(res, n)
	}
	sort.Slice(res, func(i, j int) bool {
		if res[i].Signal != res[j].Signal {
			return res[i].Signal > res[j].Signal
		}
		return res[i].SSID < res[j].SSID
	})
	return res
}

// NMConnection is one saved connection profile.
type NMConnection struct {
	Name, Type string
}

// NMConnections parses `nmcli -t -f NAME,TYPE connection show`.
func NMConnections(out string) []NMConnection {
	var res []NMConnection
	for _, f := range terseLines(out, 2) {
		res = append(res, NMConnection{Name: f[0], Type: f[1]})
	}
	return res
}
