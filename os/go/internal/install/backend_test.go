package install

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

type allow struct {
	mu   sync.Mutex
	deny bool
	seen []string
}

func (a *allow) Authorize(_ context.Context, sender, action string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.seen = append(a.seen, sender+" "+action)
	if a.deny {
		return errors.New("polkit said no")
	}
	return nil
}

const erasePlanJSON = `{"locale":"en_US.UTF-8","keyboard":"us","timezone":"Africa/Cairo","disk":{"path":"/dev/nvme0n1","mode":"erase"},"encrypt":true,` +
	`"user":{"fullName":"Ada Lovelace","username":"ada","hostname":"ada-laptop","autologin":false},"brain":{"kind":"local","modelId":"small-4b"}}`

type execCall struct {
	pl  Planned
	sec Secrets
}

func newBackend(auth *allow) (*Backend, chan execCall, chan *Gate) {
	calls, gates := make(chan execCall, 1), make(chan *Gate, 1)
	ids := 0
	b := &Backend{
		Auth:    auth,
		ProbeFn: func(context.Context) (ProbeResult, error) { return probe(emptyDisk()), nil },
		NewID:   func() string { ids++; return []string{"", "plan-a", "plan-b"}[ids] },
		ExecuteFn: func(_ context.Context, _ Deps, pl Planned, sec Secrets, g *Gate) {
			gates <- g
			calls <- execCall{pl, sec}
		},
	}
	return b, calls, gates
}

func busName(t *testing.T, err error) string {
	t.Helper()
	var be *BusError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want *BusError", err)
	}
	return be.Name
}

func TestBackendProbePlanExecute(t *testing.T) {
	auth := &allow{}
	b, calls, gates := newBackend(auth)
	out, err := b.Probe(context.Background(), ":1.5")
	if err != nil || !strings.Contains(out, `"uefi":true`) || strings.Contains(out, "LastUsable") {
		t.Fatalf("probe = %.200s, %v", out, err)
	}
	planJSON, err := b.Plan(context.Background(), ":1.5", erasePlanJSON)
	if err != nil {
		t.Fatal(err)
	}
	var pub InstallPlan
	if json.Unmarshal([]byte(planJSON), &pub) != nil || pub.PlanID != "plan-a" || len(pub.Summary) == 0 {
		t.Fatalf("plan = %s", planJSON)
	}
	if strings.Contains(planJSON, "hunter") || strings.Contains(planJSON, "sgdisk") {
		t.Fatal("the public plan carries no secrets and no commands")
	}
	// A second Plan replaces the first: the old id is dead.
	if _, err := b.Plan(context.Background(), ":1.5", erasePlanJSON); err != nil {
		t.Fatal(err)
	}
	if err := b.Execute(context.Background(), ":1.5", "plan-a", `{"userPassword":"pw","luksPassphrase":"correct horse"}`); busName(t, err) != ErrUnknownPlan {
		t.Fatal("stale plan id must be refused")
	}
	if err := b.Execute(context.Background(), ":1.5", "plan-b", `{"userPassword":"pw","luksPassphrase":null}`); busName(t, err) != ErrInvalid {
		t.Fatal("encrypting without a passphrase must be refused")
	}
	if err := b.Execute(context.Background(), ":1.5", "plan-b", `{"userPassword":"pw","luksPassphrase":"correct horse"}`); err != nil {
		t.Fatal(err)
	}
	g := <-gates
	c := <-calls
	b.Wait()
	if c.pl.Public.PlanID != "plan-b" || c.sec.UserPassword != "pw" || g == nil {
		t.Fatalf("executed %+v", c)
	}
	if err := b.Execute(context.Background(), ":1.5", "plan-b", `{"userPassword":"pw","luksPassphrase":"correct horse"}`); busName(t, err) != ErrBusy {
		t.Fatal("a second Execute must be refused")
	}
	if _, err := b.Plan(context.Background(), ":1.5", erasePlanJSON); busName(t, err) != ErrBusy {
		t.Fatal("Plan after Execute must be refused")
	}
	if _, err := b.Probe(context.Background(), ":1.5"); busName(t, err) != ErrBusy {
		t.Fatal("Probe after Execute must be refused")
	}
	for _, s := range auth.seen {
		if s != ":1.5 "+ActionRun {
			t.Fatalf("authorization = %v", auth.seen)
		}
	}
}

func TestBackendRefusedAndInvalidErrors(t *testing.T) {
	b, _, _ := newBackend(&allow{})
	refused := strings.Replace(erasePlanJSON, `"modelId":"small-4b"`, `"modelId":"gpu-32b"`, 1)
	_, err := b.Plan(context.Background(), ":1.5", refused)
	var be *BusError
	if !errors.As(err, &be) || be.Name != ErrRefused || !strings.HasPrefix(be.Message, RefuseModelDoesNotFit+": ") {
		t.Fatalf("err = %v", err)
	}
	if _, err := b.Plan(context.Background(), ":1.5", `{"locale":1}`); busName(t, err) != ErrInvalid {
		t.Fatal("malformed choices")
	}
}

func TestBackendDeniesEveryMethod(t *testing.T) {
	b, _, _ := newBackend(&allow{deny: true})
	ctx := context.Background()
	_, e1 := b.Probe(ctx, ":1.9")
	_, e2 := b.Plan(ctx, ":1.9", erasePlanJSON)
	e3 := b.Execute(ctx, ":1.9", "x", "{}")
	e4 := b.Cancel(ctx, ":1.9")
	for i, err := range []error{e1, e2, e3, e4} {
		if busName(t, err) != ErrDenied {
			t.Fatalf("method %d: %v", i, err)
		}
	}
}

func TestBackendCancel(t *testing.T) {
	b, calls, gates := newBackend(&allow{})
	b.ExecuteFn = func(_ context.Context, _ Deps, pl Planned, sec Secrets, g *Gate) {
		gates <- g
		<-calls // block until the test lets it finish
	}
	if _, err := b.Plan(context.Background(), ":1.5", erasePlanJSON); err != nil {
		t.Fatal(err)
	}
	if err := b.Execute(context.Background(), ":1.5", "plan-a", `{"userPassword":"pw","luksPassphrase":"correct horse"}`); err != nil {
		t.Fatal(err)
	}
	g := <-gates
	if err := b.Cancel(context.Background(), ":1.5"); err != nil {
		t.Fatalf("cancel before the first write: %v", err)
	}
	if g.Commit() {
		t.Fatal("a cancelled gate must not commit")
	}
	calls <- execCall{}
	b.Wait()

	b2, calls2, gates2 := newBackend(&allow{})
	b2.ExecuteFn = func(_ context.Context, _ Deps, _ Planned, _ Secrets, g *Gate) {
		g.Commit()
		gates2 <- g
		<-calls2
	}
	b2.Plan(context.Background(), ":1.5", erasePlanJSON)
	b2.Execute(context.Background(), ":1.5", "plan-a", `{"userPassword":"pw","luksPassphrase":"correct horse"}`)
	<-gates2
	if err := b2.Cancel(context.Background(), ":1.5"); busName(t, err) != ErrNotCancellable {
		t.Fatalf("cancel after the first write: %v", err)
	}
	calls2 <- execCall{}
	b2.Wait()
}
