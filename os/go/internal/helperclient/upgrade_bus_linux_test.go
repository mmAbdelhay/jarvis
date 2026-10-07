//go:build linux

package helperclient

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helper"
	"github.com/mmAbdelhay/jarvis/os/go/internal/helperapi"
)

// The two M2 methods over a real private bus: wire signature, sender, and
// the error mapping for a refused call.
func TestUpgradeMethodsOverARealBus(t *testing.T) {
	addr := privateBus(t)
	run := (&execx.Fake{}).
		On(execx.OK("curl\t8\tinstalled\n"), "dpkg-query", "-W", "-f=${Package}\t${Version}\t${db:Status-Status}\n", "--", "curl").
		On(execx.Result{Stderr: []byte("upgraded\n")}, "apt-get", "install", "--only-upgrade", "-y", "--no-install-recommends", "--no-remove",
			"-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "--", "curl")
	auth := &recordingAuth{}
	svc := &helper.Service{Run: run, Auth: auth, Now: time.Now, ListsAge: func() (time.Duration, error) { return 0, nil }}
	if err := helper.Export(connect(t, addr), &helper.Object{Svc: svc}); err != nil {
		t.Fatal(err)
	}
	client := NewWithConn(connect(t, addr))
	out, err := client.AptUpgrade(context.Background(), []string{"curl"})
	if err != nil || !out.OK || out.StderrTail != "upgraded\n" {
		t.Fatalf("AptUpgrade = %+v, %v", out, err)
	}
	_, err = client.FlatpakUpdate(context.Background(), []string{"not-an-app-id"})
	var he *helperapi.Error
	if !errors.As(err, &he) || he.Code() != "invalid" {
		t.Fatalf("FlatpakUpdate bad ref: %v", err)
	}
}
