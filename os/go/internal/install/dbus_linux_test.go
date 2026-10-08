//go:build linux

package install

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/godbus/dbus/v5"
)

// A private session bus (no root, no polkit): the real godbus export, the
// method signatures, error names and the three signals end to end.
func TestInstallerOverARealBus(t *testing.T) {
	if _, err := exec.LookPath("dbus-daemon"); err != nil {
		t.Skip("dbus-daemon not installed")
	}
	cmd := exec.Command("dbus-daemon", "--session", "--nofork", "--print-address=1")
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	addr, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	server, err := dbus.Connect(strings.TrimSpace(addr))
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := dbus.Connect(strings.TrimSpace(addr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	b, _, _ := newBackend(&allow{})
	b.ExecuteFn = func(_ context.Context, d Deps, _ Planned, _ Secrets, _ *Gate) {
		d.Events.Progress("partition", 50, "half")
		d.Events.ModelProgress(7, "Downloading")
		d.Events.Finished(true, "", "done")
	}
	if err := Export(server, &Object{B: b}); err != nil {
		t.Fatal(err)
	}
	if err := client.AddMatchSignal(dbus.WithMatchInterface(Interface)); err != nil {
		t.Fatal(err)
	}
	sigs := make(chan *dbus.Signal, 10)
	client.Signal(sigs)

	obj := client.Object(BusName, ObjectPath)
	var probeJSON, planJSON string
	if err := obj.Call(Interface+".Probe", 0).Store(&probeJSON); err != nil || !strings.Contains(probeJSON, `"disks"`) {
		t.Fatalf("Probe: %v", err)
	}
	refused := strings.Replace(erasePlanJSON, `"modelId":"small-4b"`, `"modelId":"gpu-32b"`, 1)
	err = obj.Call(Interface+".Plan", 0, refused).Err
	if de, ok := err.(dbus.Error); !ok || de.Name != ErrRefused || !strings.HasPrefix(de.Body[0].(string), "model-does-not-fit: ") {
		t.Fatalf("refused plan: %#v", err)
	}
	if err := obj.Call(Interface+".Plan", 0, erasePlanJSON).Store(&planJSON); err != nil || !strings.Contains(planJSON, `"planId":"plan-b"`) {
		t.Fatalf("Plan: %s %v", planJSON, err)
	}
	if err := obj.Call(Interface+".Execute", 0, "plan-b", `{"userPassword":"pw","luksPassphrase":"correct horse"}`).Err; err != nil {
		t.Fatal(err)
	}
	want := []string{"Progress [partition 50 half]", "ModelProgress [7 Downloading]", "Finished [true  done]"}
	for _, w := range want {
		select {
		case s := <-sigs:
			if got := strings.TrimPrefix(s.Name, Interface+".") + " " + fmt.Sprint(s.Body); got != w {
				t.Fatalf("signal %q, want %q", got, w)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no %s signal", w)
		}
	}
}
