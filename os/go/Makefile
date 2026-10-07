# Jarvis OS Go tools. Targets work on macOS and Linux.
GO      ?= go

.PHONY: all check test

all: check test

check:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	$(GO) vet ./...
	GOOS=linux $(GO) vet ./...

test:
	$(GO) test -race ./...
