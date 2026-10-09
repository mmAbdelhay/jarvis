# Jarvis OS Go tools. Targets work on macOS and Linux; `dist` always
# cross-builds static linux binaries (CGO off, godbus is pure Go).
GO      ?= go
GOOS    ?= linux
GOARCH  ?= amd64
VERSION ?= $(shell git describe --tags --match 'os-v*' --always 2>/dev/null || echo dev)
DIST    := dist
RECIPES ?= ../recipes
BUILD   := CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build -trimpath -ldflags '-s -w -X main.version=$(VERSION)'

.PHONY: all check test dist registry clean recipes-check i18n-check

all: check test

check:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	$(GO) vet ./...
	GOOS=linux $(GO) vet ./...
	@if [ -d "$(RECIPES)" ]; then $(GO) run ./tools/recipecheck "$(RECIPES)"; fi

test: i18n-check
	$(GO) test -race ./...

# Rafiq M4 contracts §4, §6: Plan T validates its recipe files with this.
recipes-check:
	$(GO) run ./tools/recipecheck "$(RECIPES)"

# Rafiq M4 contracts §3 CI gate: every card table complete in en and ar.
i18n-check:
	$(GO) test ./internal/i18n/...

# dist/ mirrors the target filesystem (M1 contracts §2, §4; M2 contracts §7);
# the packaging plan splits it into packages by path.
dist: clean
	$(BUILD) -o $(DIST)/usr/lib/jarvis/mcp/jarvis-pkg ./cmd/jarvis-pkg
	$(BUILD) -o $(DIST)/usr/lib/jarvis/mcp/jarvis-diag ./cmd/jarvis-diag
	$(BUILD) -o $(DIST)/usr/libexec/jarvis/jarvis-helper ./cmd/jarvis-helper
	$(BUILD) -o $(DIST)/usr/libexec/jarvis/jarvis-installer-backend ./cmd/jarvis-installer-backend
	$(BUILD) -o $(DIST)/usr/libexec/jarvis/jarvis-model-fetch ./cmd/jarvis-model-fetch
	$(BUILD) -o $(DIST)/usr/lib/jarvis/mcp/jarvis-settings ./cmd/jarvis-settings
	$(BUILD) -o $(DIST)/usr/lib/jarvis/mcp/jarvis-apps ./cmd/jarvis-apps
	$(BUILD) -o $(DIST)/usr/lib/jarvis/mcp/jarvis-files ./cmd/jarvis-files-os
	$(BUILD) -o $(DIST)/usr/libexec/jarvis/jarvis-wl ./cmd/jarvis-wl
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

# Official registry servers (Rafiq M2.5 contracts section 3 and 7): static
# linux binaries at dist-registry/<id>/server, deterministic artifacts under
# dist-registry/artifacts/, and entries.json for the signed index.
# -buildvcs=false keeps a dirty worktree from changing the bytes.
REGISTRY_VERSION  ?= $(patsubst os-v%,%,$(VERSION))
REGISTRY_BASE_URL ?= https://mmabdelhay.github.io/jarvis-apt/registry/artifacts
REGISTRY_OUT      := dist-registry

# Published versions are immutable (contracts section 7 #7): the binaries embed
# the version from os/registry/servers/<id>.json, never the git describe, so
# every commit yields the same bytes for the same published id/version.
REG_BUILD := CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) $(GO) build -trimpath -buildvcs=false
regver = $$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' ../registry/servers/$(1).json)

registry:
	rm -rf $(REGISTRY_OUT)
	for id in jarvis-clock jarvis-files jarvis-web; do \
		v=$(call regver,$$id) || exit 1; \
		$(REG_BUILD) -ldflags "-s -w -X main.version=$$v" -o $(REGISTRY_OUT)/$$id/server ./cmd/$$id || exit 1; \
	done
	$(GO) run ./tools/regpack -bin $(REGISTRY_OUT) -out $(REGISTRY_OUT) \
		-version $(REGISTRY_VERSION) -base-url $(REGISTRY_BASE_URL) -license ../../LICENSE

clean:
	rm -rf $(DIST) $(REGISTRY_OUT)
