// jarvis-clock is the official registry server for time and timers
// (Rafiq M2.5 contracts §3). jarvisd starts it in a user-scope sandbox
// without network and speaks MCP over stdin/stdout.
package main

import (
	"os"
	_ "time/tzdata" // works in a sandbox without /usr/share/zoneinfo

	"github.com/mmAbdelhay/jarvis/os/go/internal/clocktools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/official"
)

var version = "dev"

func main() {
	deps := clocktools.Deps{
		Local: clocktools.LocalZone(os.Getenv, os.Readlink),
	}
	official.Serve(clocktools.Manifest, version, clocktools.Tools(deps))
}
