package main

import (
	"bufio"
	"os"
	"os/exec"
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

// TestBinaryListsWebFetchAndRefusesLocalhost keeps stdin open until the
// answer arrives: the server cancels in-flight calls when stdin closes.
func TestBinaryListsWebFetchAndRefusesLocalhost(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "JARVIS_RUN_MAIN=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	stdin.Write([]byte(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}` + "\n" +
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web.fetch","arguments":{"url":"http://127.0.0.1:11434/api/tags"}}}` + "\n"))
	var out strings.Builder
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		out.WriteString(sc.Text() + "\n")
		if strings.Contains(sc.Text(), `"id":2`) {
			break
		}
	}
	stdin.Close()
	cmd.Wait()
	s := out.String()
	for _, want := range []string{`"name":"web.fetch"`, `"isError":true`, `"code":"not_allowed"`} {
		if !strings.Contains(s, want) {
			t.Errorf("output lacks %s:\n%s", want, s)
		}
	}
}
