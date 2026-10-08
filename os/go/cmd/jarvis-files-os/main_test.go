package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("JARVIS_RUN_MAIN") == "1" {
		main()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// TestBuiltInServerTrashesOverStdio runs the real loop: the read and write
// tools are listed under the name jarvis-files, and a trash really lands in
// $XDG_DATA_HOME/Trash with an undo object.
func TestBuiltInServerTrashesOverStdio(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "old.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "JARVIS_RUN_MAIN=1", "HOME="+home, "XDG_DATA_HOME=", "XDG_STATE_HOME=")
	cmd.Stdin = strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n" +
			`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"files.trash","arguments":{"items":[{"from":"~/old.txt"}]}}}` + "\n")
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	s := string(out)
	for _, want := range []string{`"name":"jarvis-files"`, `"name":"files.search"`, `"name":"files.move"`, `"name":"files.undo"`, `"name":"files.trash_list"`, `"undo":{"input":{"journalId":`, `"to":"trash:old.txt"`} {
		if !strings.Contains(s, want) {
			t.Errorf("output lacks %s:\n%s", want, s)
		}
	}
	if _, err := os.Stat(filepath.Join(home, ".local", "share", "Trash", "files", "old.txt")); err != nil {
		t.Fatalf("not in the trash: %v", err)
	}

	// A second server run over the same home lists the trashed file.
	list := exec.Command(os.Args[0])
	list.Env = cmd.Env
	list.Stdin = strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"files.trash_list","arguments":{"query":"old"}}}` + "\n")
	lout, err := list.Output()
	if err != nil {
		t.Fatalf("%v: %s", err, lout)
	}
	for _, want := range []string{`\"originalPath\":\"~/old.txt\"`, `\"trash\":\"trash:old.txt\"`, `\"deletedAt\":`} {
		if !strings.Contains(string(lout), want) {
			t.Errorf("trash_list lacks %s:\n%s", want, lout)
		}
	}
}
