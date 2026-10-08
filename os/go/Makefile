# Jarvis OS Go tools. Targets work on macOS and Linux; `dist` always
# cross-builds static linux binaries (CGO off, godbus is pure Go).
GO      ?= go
GOOS    ?= linux
GOARCH  ?= amd64
VERSION ?= $(shell git describe --tags --match 'os-v*' --always 2>/dev/null || echo dev)
DIST    := dist
BUILD   := CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build -trimpath -ldflags '-s -w -X main.version=$(VERSION)'

.PHONY: all check test dist clean

all: check test

check:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	$(GO) vet ./...
	GOOS=linux $(GO) vet ./...

test:
	$(GO) test -race ./...

# dist/ mirrors the target filesystem (M1 contracts §2, §4; M2 contracts §7);
# the packaging plan splits it into packages by path.
dist: clean
	$(BUILD) -o $(DIST)/usr/lib/jarvis/mcp/jarvis-pkg ./cmd/jarvis-pkg
	$(BUILD) -o $(DIST)/usr/lib/jarvis/mcp/jarvis-diag ./cmd/jarvis-diag
	$(BUILD) -o $(DIST)/usr/libexec/jarvis/jarvis-helper ./cmd/jarvis-helper
	$(BUILD) -o $(DIST)/usr/libexec/jarvis/jarvis-installer-backend ./cmd/jarvis-installer-backend
	$(BUILD) -o $(DIST)/usr/libexec/jarvis/jarvis-model-fetch ./cmd/jarvis-model-fetch
	mkdir -p $(DIST)/usr/share/dbus-1/system.d $(DIST)/usr/share/dbus-1/system-services \
		$(DIST)/usr/lib/systemd/system $(DIST)/usr/share/polkit-1/actions
	install -m 0644 data/os.jarvis.Helper1.conf $(DIST)/usr/share/dbus-1/system.d/os.jarvis.Helper1.conf
	install -m 0644 data/os.jarvis.Helper1.service $(DIST)/usr/share/dbus-1/system-services/os.jarvis.Helper1.service
	install -m 0644 data/jarvis-helper.service $(DIST)/usr/lib/systemd/system/jarvis-helper.service
	install -m 0644 data/os.jarvis.helper.policy $(DIST)/usr/share/polkit-1/actions/os.jarvis.helper.policy
	install -m 0644 data/os.jarvis.Installer1.conf $(DIST)/usr/share/dbus-1/system.d/os.jarvis.Installer1.conf
	install -m 0644 data/os.jarvis.Installer1.service $(DIST)/usr/share/dbus-1/system-services/os.jarvis.Installer1.service
	install -m 0644 data/jarvis-installer-backend.service $(DIST)/usr/lib/systemd/system/jarvis-installer-backend.service
	install -m 0644 data/os.jarvis.installer.policy $(DIST)/usr/share/polkit-1/actions/os.jarvis.installer.policy
	install -m 0644 data/jarvis-model-fetch.service $(DIST)/usr/lib/systemd/system/jarvis-model-fetch.service

clean:
	rm -rf $(DIST)
