// jarvis-files-os is the built-in jarvis-files of Rafiq (Rafiq M3
// contracts §1): the read-only tools of the registry server plus the write
// tools (move, copy, rename, mkdir, trash, restore, hidden undo). It is
// installed as /usr/lib/jarvis/mcp/jarvis-files and started by jarvisd like
// jarvis-pkg, outside the registry sandbox, because the registry sandbox
// (M2.5 contracts §7.1/§7.4) cannot grant writes to $HOME or the trash.
package main

import (
	"os"
	"path/filepath"

	"github.com/mmAbdelhay/jarvis/os/go/internal/fileops"
	"github.com/mmAbdelhay/jarvis/os/go/internal/filestools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/homepath"
	"github.com/mmAbdelhay/jarvis/os/go/internal/official"
	"github.com/mmAbdelhay/jarvis/os/go/internal/trash"
)

var version = "dev"

func main() {
	home := os.Getenv("HOME")
	if home != "" {
		home = filepath.Clean(home)
	}
	ops := &fileops.Ops{
		Paths:   homepath.Resolver{Home: home},
		Trash:   trash.Home(os.Getenv),
		Journal: fileops.Journal{Dir: fileops.StateDir(os.Getenv)},
	}
	tools := append(filestools.Tools(filestools.Deps{Home: home}), filestools.WriteTools(filestools.WriteDeps{Ops: ops})...)
	official.Serve(filestools.Manifest, version, tools)
}
