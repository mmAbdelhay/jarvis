// jarvis-wl is a small command-line front end to internal/wl for
// diagnosis and the distro's smoke tests (Rafiq M3 contracts §1: the
// jarvis-apps Wayland helper). jarvis-apps itself links internal/wl and
// keeps one connection, so window ids stay stable between tool calls.
//
//	jarvis-wl list               JSON array of open windows
//	jarvis-wl focus <appId>      focus the newest window of appId
//	jarvis-wl close <appId>      close every window of appId
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/wl"
)

func run(args []string, stdout io.Writer, getenv func(string) string, readDir func(string) ([]os.DirEntry, error)) error {
	if len(args) == 0 || (args[0] != "list" && args[0] != "focus" && args[0] != "close") || (args[0] != "list" && len(args) != 2) || (args[0] == "list" && len(args) != 1) {
		return fmt.Errorf("usage: jarvis-wl list | focus <appId> | close <appId>")
	}
	path, err := wl.SocketPath(getenv, readDir)
	if err != nil {
		return err
	}
	c, err := wl.Dial(path, 2*time.Second)
	if err != nil {
		return err
	}
	defer c.Close()
	ws, err := c.Windows()
	if err != nil {
		return err
	}
	switch args[0] {
	case "list":
		return json.NewEncoder(stdout).Encode(ws)
	case "focus", "close":
		var hit []wl.Window
		for _, w := range ws {
			if strings.EqualFold(w.AppID, args[1]) {
				hit = append(hit, w)
			}
		}
		if len(hit) == 0 {
			return fmt.Errorf("no window of %s", args[1])
		}
		if args[0] == "focus" {
			return c.Activate(hit[len(hit)-1].ID)
		}
		for _, w := range hit {
			if err := c.CloseWindow(w.ID); err != nil {
				return err
			}
		}
		return nil
	}
	return fmt.Errorf("unknown command %q", args[0])
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Getenv, os.ReadDir); err != nil {
		fmt.Fprintln(os.Stderr, "jarvis-wl:", err)
		os.Exit(1)
	}
}
