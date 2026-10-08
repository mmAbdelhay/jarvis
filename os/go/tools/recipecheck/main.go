// recipecheck validates Rafiq recipe files (Rafiq M4 contracts §4, §6) the way
// jarvis-pkg will load them: format, both languages, file name = id, and
// every step allowed by jarvis-pkg's allowlist with input that tool
// accepts. Ownership is not checked here (the files are not installed
// yet); the jarvis-recipes package installs them root-owned, 0644.
//
//	recipecheck DIR
package main

import (
	"fmt"
	"io"
	"io/fs"
	"os"

	"github.com/mmAbdelhay/jarvis/os/go/internal/pkgtools"
	"github.com/mmAbdelhay/jarvis/os/go/internal/recipes"
)

func main() { os.Exit(run(os.Args[1:], os.Stdout, os.Stderr)) }

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) != 1 {
		fmt.Fprintln(stderr, "usage: recipecheck DIR")
		return 2
	}
	store := &recipes.Store{FS: os.DirFS(args[0]), Dir: ".", Trusted: func(fs.FileInfo) error { return nil }}
	list, probs, err := store.List()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	bad := len(probs)
	for _, p := range probs {
		fmt.Fprintf(stderr, "%s: %s\n", p.File, p.Reason)
	}
	for _, r := range list {
		if err := pkgtools.CheckRecipe(r); err != nil {
			fmt.Fprintf(stderr, "%s.json: %v\n", r.ID, err)
			bad++
			continue
		}
		fmt.Fprintf(stdout, "ok %s (%d steps)\n", r.ID, len(r.Steps))
	}
	if len(list) == 0 && bad == 0 {
		fmt.Fprintln(stderr, "no recipes found in", args[0])
		return 1
	}
	if bad > 0 {
		return 1
	}
	return 0
}
