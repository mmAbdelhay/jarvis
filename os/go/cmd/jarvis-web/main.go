// jarvis-web is the official registry server that fetches public web
// pages as text (Rafiq M2.5 contracts §3). jarvisd starts it in a
// user-scope sandbox with network and $HOME read-only.
package main

import (
	"github.com/mmAbdelhay/jarvis/os/go/internal/official"
	"github.com/mmAbdelhay/jarvis/os/go/internal/webtools"
)

var version = "dev"

func main() {
	official.Serve(webtools.Manifest, version, webtools.Tools(webtools.Deps{UserAgent: "Jarvis-Web/" + version}))
}
