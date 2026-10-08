// jarvis-files is the official registry server for finding and previewing
// files in $HOME (Rafiq M2.5 contracts §3). jarvisd starts it in a
// user-scope sandbox without network and with $HOME read-only.
package main

import (
	"os"
	"path/filepath"

	"github.com/mmAbdelhay/jarvis/os/go/internal/filestools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/official"
)

var version = "dev"

func main() {
	home := os.Getenv("HOME")
	if home != "" {
		home = filepath.Clean(home)
	}
	official.Serve(filestools.Manifest, version, filestools.Tools(filestools.Deps{Home: home}))
}
