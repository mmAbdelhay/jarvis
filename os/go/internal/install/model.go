package install

import (
	"context"
	"fmt"
	"net"
	"strconv"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/execx"
	"github.com/mmAbdelhay/jarvis/os/go/internal/modelstate"
	"github.com/mmAbdelhay/jarvis/os/go/internal/ollama"
)

// FreeLoopbackPort asks the kernel for an unused 127.0.0.1 port.
func FreeLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// startModel begins the model download in the background, right after the
// copy (the target's own ollama binary must exist; Plan H ships it in
// jarvis-ollama). It runs alongside configure and bootloader. The state
// file and the pending marker are written first, so whatever happens next,
// jarvis-model-fetch finishes the job on first boot.
func (j *job) startModel(ctx context.Context) error {
	m := j.pl.Model
	if m == nil {
		return nil
	}
	st := modelstate.State{ModelID: m.ID, OllamaTag: m.OllamaTag, State: modelstate.Pending, Message: text.ModelLater}
	if err := modelstate.MarkPending(j.d.Files, Target); err != nil {
		return err
	}
	if err := modelstate.Write(j.d.Files, Target, st, j.now()); err != nil {
		return err
	}
	if !j.pl.Online {
		j.d.Log.Printf("model: offline, %s downloads on first boot", m.OllamaTag)
		j.d.Events.ModelProgress(0, text.ModelOffline)
		return nil
	}
	mctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	j.modelCancel, j.modelDone = cancel, make(chan error, 1)
	go func() { j.modelDone <- j.pullModel(mctx, st) }()
	return nil
}

func (j *job) now() time.Time {
	if j.d.Now == nil {
		return time.Now()
	}
	return j.d.Now()
}

// pullModel runs `chroot /target ollama serve` on a free loopback port and
// pulls the model through it, so the files land in the target's
// /var/lib/ollama/models. Failure is not an install failure.
func (j *job) pullModel(ctx context.Context, st modelstate.State) error {
	port, err := j.d.FreePort()
	if err != nil {
		return err
	}
	serveCtx, stopServe := context.WithCancel(ctx)
	served := make(chan struct{})
	go func() {
		defer close(served)
		res, err := j.d.ModelRun(port).Run(serveCtx, execx.Cmd{Name: "chroot", Args: []string{Target, "ollama", "serve"}, Timeout: 24 * time.Hour})
		if err != nil && serveCtx.Err() == nil {
			j.d.Log.Printf("model: ollama serve stopped: %v %s", err, lastLine(string(res.Stderr)))
		}
	}()
	defer func() { stopServe(); <-served }()

	client := &ollama.Client{BaseURL: "http://127.0.0.1:" + strconv.Itoa(port), HTTP: j.d.HTTP, Stall: j.d.ModelStall}
	upCtx, cancelUp := context.WithTimeout(ctx, 60*time.Second)
	err = client.WaitUp(upCtx, j.d.every())
	cancelUp()
	if err == nil {
		j.d.Log.Printf("model: pulling %s", st.OllamaTag)
		j.d.Events.ModelProgress(0, text.ModelWaiting)
		last := -1
		err = client.Pull(ctx, st.OllamaTag, func(p ollama.Progress) {
			if p.Percent == last {
				return
			}
			last = p.Percent
			j.d.Events.ModelProgress(p.Percent, fmt.Sprintf(text.ModelDownloading, j.pl.Model.DisplayName))
			st.State, st.Percent, st.Message = modelstate.Downloading, p.Percent, p.Status
			_ = modelstate.Write(j.d.Files, Target, st, j.now())
		})
	}
	if err == nil {
		var ok bool
		if ok, err = client.Has(ctx, st.OllamaTag); err == nil && !ok {
			err = fmt.Errorf("%s is not listed after the pull", st.OllamaTag)
		}
	}
	if err != nil {
		j.d.Log.Printf("model: %v; first boot will continue", err)
		st.State, st.Message = modelstate.Pending, text.ModelLater
		_ = modelstate.Write(j.d.Files, Target, st, j.now())
		j.d.Events.ModelProgress(st.Percent, text.ModelLater)
		return err
	}
	st.State, st.Percent, st.Message = modelstate.Ready, 100, ""
	if err := modelstate.Write(j.d.Files, Target, st, j.now()); err != nil {
		return err
	}
	if err := modelstate.ClearPending(j.d.Files, Target); err != nil {
		return err
	}
	j.d.Log.Printf("model: %s ready", st.OllamaTag)
	j.d.Events.ModelProgress(100, fmt.Sprintf(text.ModelDone, j.pl.Model.DisplayName))
	return nil
}

// waitModel waits for the download (stall-limited by ollama.Client), then
// reports the model step done either way.
func (j *job) waitModel(ctx context.Context) error {
	if j.pl.Model == nil {
		return nil
	}
	j.begin("model")
	if j.modelDone != nil {
		<-j.modelDone
		j.modelCancel()
		j.modelCancel, j.modelDone = nil, nil
	}
	j.done()
	return nil
}
