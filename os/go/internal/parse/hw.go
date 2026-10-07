package parse

import "strings"

// PCIDevice is one device from `lspci -k`.
type PCIDevice struct {
	Slot, Name, Driver string
}

// LspciK parses `lspci -k`: a device line ("00:02.0 Ethernet controller:
// ...") followed by indented detail lines. Driver is "Kernel driver in use",
// empty when no driver is bound (often the actual problem).
func LspciK(out string) []PCIDevice {
	var res []PCIDevice
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if line[0] == ' ' || line[0] == '\t' {
			if len(res) == 0 {
				continue
			}
			k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
			if ok && k == "Kernel driver in use" {
				res[len(res)-1].Driver = strings.TrimSpace(v)
			}
			continue
		}
		slot, name, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		res = append(res, PCIDevice{Slot: slot, Name: strings.TrimSpace(name)})
	}
	return res
}

// USBDevice is one line of `lsusb`.
type USBDevice struct {
	ID, Name string
}

// Lsusb parses "Bus 001 Device 002: ID 8087:0024 Intel Corp. Hub".
func Lsusb(out string) []USBDevice {
	var res []USBDevice
	for _, line := range strings.Split(out, "\n") {
		_, rest, ok := strings.Cut(line, ": ID ")
		if !ok {
			continue
		}
		id, name, _ := strings.Cut(rest, " ")
		res = append(res, USBDevice{ID: id, Name: strings.TrimSpace(name)})
	}
	return res
}
