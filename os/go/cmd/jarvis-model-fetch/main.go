// jarvis-model-fetch finishes the local model download on first boot
// (M2 contracts §5, §7). jarvis-model-fetch.service starts it only while
// /var/lib/jarvis/model-pending exists; it exits 0 once the model is ready.
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/mmAbdelhay/jarvis/os/go/internal/files"
	"github.com/mmAbdelhay/jarvis/os/go/internal/modelfetch"
	"github.com/mmAbdelhay/jarvis/os/go/internal/ollama"
)

var version = "dev"

func main() {
	log.SetFlags(0)
	log.SetPrefix("jarvis-model-fetch: ")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	err := modelfetch.Run(ctx, modelfetch.Deps{
		Files:  &files.OS{},
		Ollama: &ollama.Client{BaseURL: "http://127.0.0.1:11434"},
		Now:    time.Now,
		Logf:   log.Printf,
	})
	switch {
	case err == nil, errors.Is(err, modelfetch.ErrNothingToDo):
		return
	case errors.Is(err, context.Canceled):
		log.Print("stopped; the download resumes at the next start")
		os.Exit(0)
	default:
		log.Fatal(err)
	}
}
