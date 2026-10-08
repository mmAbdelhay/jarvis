#!/usr/bin/env bash
# os.yml wiring that a typo would silently break.
source "$(dirname "$0")/lib.sh"
wf=$REPO_ROOT/.github/workflows/os.yml
check "workflow is valid YAML" python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1]))' "$wf"
y() { python3 -c 'import sys,yaml,json; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))' "$wf"; }
jobs=$(y | python3 -c 'import sys,json; print(" ".join(json.load(sys.stdin)["jobs"]))')
for j in checks build-go loop-tests build-daemon build-qt build-distro build-iso smoke-test install-test repo release; do
  check "job $j" grep -qw "$j" <<<"$jobs"
done
check "install tests: four scenarios" grep -q 'scenario: \[erase, alongside, refusals, local-model\]' "$wf"
check "loop tests run the Go TestLoop suite as root (Plan F Task 14)" python3 - "$wf" <<'PY'
import sys, yaml
j = yaml.safe_load(open(sys.argv[1]))["jobs"]["loop-tests"]
run = " ".join(s.get("run", "") for s in j["steps"])
assert "JARVIS_LOOP_TESTS=1" in run and "run TestLoop" in run and "sudo" in run, run
PY
check "install tests need KVM" grep -q 'install tests need KVM' "$wf"
check "release waits for install tests" python3 - "$wf" <<'PY'
import sys, yaml
j = yaml.safe_load(open(sys.argv[1]))["jobs"]
assert set(j["release"]["needs"]) >= {"smoke-test", "install-test", "loop-tests"}, j["release"]["needs"]
assert set(j["repo"]["needs"]) >= {"smoke-test", "install-test", "loop-tests"}, j["repo"]["needs"]
PY
check "release build guards the keyring" grep -q 'JARVIS_RELEASE: ' "$wf"
check "repo skipped with a warning without the secret" grep -q '::warning title=APT repo::' "$wf"
check "no secret echoed" bash -c "! grep -nE 'echo .*secrets\\.' '$wf'"
check "os paths still filtered" grep -q '"os/\*\*"' "$wf"
# --- M2.5 Plan L ---
for j in agent-install docker-image docker-publish; do check "job $j" grep -qw "$j" <<<"$jobs"; done
check "CLI sources trigger the workflow" grep -qF '"packages/cli/**"' "$wf"
check "M2.5 wiring" python3 - "$wf" <<'PY'
import sys, yaml
w = yaml.safe_load(open(sys.argv[1]))
j = w["jobs"]
d = lambda name: yaml.safe_dump(j[name])
assert w["permissions"] == {"contents": "read"}, w["permissions"]
assert j["agent-install"]["strategy"]["matrix"]["image"] == ["debian:trixie", "ubuntu:24.04"]
assert set(j["agent-install"]["needs"]) >= {"build-go", "build-daemon", "build-distro"}
assert "--level chat" in d("agent-install")
assert "test-image.sh" in d("docker-image") and "fake-health.json" in d("docker-image")
assert "refs/tags/os-v" in j["docker-publish"]["if"]
assert j["docker-publish"]["permissions"] == {"contents": "read", "packages": "write"}
assert set(j["docker-publish"]["needs"]) >= {"docker-image", "agent-install", "smoke-test", "install-test"}
for name in j:
    if name != "docker-publish":
        assert "docker push" not in d(name) and "docker login" not in d(name), name
dp = d("docker-publish")
assert "ver=${OS_VERSION#os-v}" in dp and "ghcr.io/mmabdelhay/jarvis-agent:$ver" in dp, dp
assert "jarvis-agent:$OS_VERSION" not in dp, dp
assert set(j["release"]["needs"]) >= {"agent-install", "docker-publish", "repo"}
assert set(j["repo"]["needs"]) >= {"agent-install", "docker-image"}
repo = d("repo")
for s in ("build_index.py", "sign-index.sh", "verify-index.sh", "--verify-remote", "--previous"):
    assert s in repo, s
assert repo.index("build-repo.sh") < repo.index("build_index.py") < repo.index("sign-index.sh") < repo.rindex("publish.sh")
assert "JARVIS_RELEASE" in repo
assert "gpgv" in repo and "gpg-agent" in repo, "repo job must install gpgv and gpg-agent"
go = d("build-go")
for s in ("package-official.sh", "test-key.sh", "sign-index.sh", "verify-index.sh", "registry-artifacts"):
    assert s in go, s
assert "voice.py scan-debs" in d("build-iso")
chk = d("checks")
for s in ("os/registry/tests/run.sh", "discover -s os/registry/tests", "voice.py validate", "busybox-static"):
    assert s in chk, s
assert "jarvis-cli" in d("build-daemon") and "@jarvis/cli build" in d("build-daemon")
assert "jarvis-agent" in d("build-distro")
PY
# --- Rafiq M3 Plan P ---
for j in build-voice voice-roundtrip session-test; do check "job $j" grep -qw "$j" <<<"$jobs"; done
check "M3 wiring" python3 - "$wf" <<'PY'
import sys, yaml
w = yaml.safe_load(open(sys.argv[1]))
j = w["jobs"]
d = lambda n: yaml.safe_dump(j[n])
needs = lambda n: {j[n]["needs"]} if isinstance(j[n]["needs"], str) else set(j[n]["needs"])
assert "jarvis-settings jarvis-apps jarvis-wl" in d("build-go")
qt = d("build-qt")
for s in ("os/lock/deps/debian-build.txt", "os/idle/deps/debian-build.txt", "os/lock/ci/test.sh",
          "os/idle/ci/test.sh", "jarvis-lock jarvis-idle"):
    assert s in qt, s
v = d("build-voice")
for s in ("jarvis-voice-engines jarvis-voice-models", "debs-voice", "voice.json", "engines.env", "voice.py scan-debs"):
    assert s in v, s
assert "build-voice" in needs("build-iso")
assert needs("voice-roundtrip") == {"build-voice"} and "os/packaging/voice/roundtrip.sh" in d("voice-roundtrip")
assert "build-qt" in needs("session-test") and "os/iso/session/run.sh" in d("session-test")
for n in ("voice-roundtrip", "session-test"):
    assert "--privileged" not in d(n), n
for n in ("repo", "release"):
    assert {"session-test", "voice-roundtrip"} <= needs(n), n
assert "discover -s os/packaging/lib/tests" in d("checks")
PY
# --- Rafiq M4 Plan T ---
for j in i18n-gate build-backup-model backup-model-test classic-session-test build-workspace; do
  check "job $j" grep -qw "$j" <<<"$jobs"
done
check "M4 CI version" grep -qF "'0.4.0~ci{0}'" "$wf"
check "electron-builder.yml triggers the workflow" grep -qF '"packages/desktop/electron-builder.yml"' "$wf"
check "M4 wiring" python3 - "$wf" <<'PY'
import sys, yaml
w = yaml.safe_load(open(sys.argv[1]))
j = w["jobs"]
d = lambda n: yaml.safe_dump(j[n], width=1000)
needs = lambda n: {j[n]["needs"]} if isinstance(j[n]["needs"], str) else set(j[n]["needs"])
c = d("checks")
for s in ("discover -s os/recipes/tests", "recipes.py validate", "check_sources.py", "backup_model.py check",
          "qt6-l10n-tools", "fonts-noto-core", "fonts-ibm-plex", "desktop-file-utils", "JARVIS_DPKG_INSTALL_TESTS"):
    assert s in c, s
assert "jarvis-session jarvis-fonts jarvis-recipes" in d("build-distro")
qt = d("build-qt")
for s in ("os/classic/deps/debian-build.txt", "os/classic/ci/test.sh", "jarvis-classic jarvis-i18n", "qt6-l10n-tools"):
    assert s in qt, s
assert "i18n_gate.py" in d("i18n-gate")
bm = d("build-backup-model")
for s in ("jarvis-backup-model", "debs-backup-model", "backup-model.lock.json", "compression-level: 0"):
    assert s in bm, s
assert needs("backup-model-test") == {"build-distro", "build-backup-model"}
assert "os/packaging/backup/offline-chat.sh" in d("backup-model-test")
assert needs("classic-session-test") == {"build-distro"} and "os/iso/session/classic.sh" in d("classic-session-test")
assert {"build-qt", "build-distro"} <= needs("session-test") and "debs-distro" in d("session-test")
ws = d("build-workspace")
for s in ("electron-builder --linux dir --x64", "jarvis-workspace", "workspace-deb",
          "for f in /opt/jarvis-workspace/jarvis ", "ldd ", "not found"):
    assert s in ws, s
# Depends must be proven in a container without the build host's libraries.
assert ws.count("docker run --rm") >= 2 and "libgtk-3-0t64" in ws.split("Install-test in a clean")[0], "clean install test"
assert "libgtk" not in ws.split("Install-test in a clean")[1], "the install-test container must not preinstall Electron's libraries"
assert "debs-" not in ws, "the workspace .deb must never reach the ISO (contracts §5)"
assert {"build-backup-model", "i18n-gate"} <= needs("build-iso")
for n in ("backup-model-test", "classic-session-test"):
    assert "--privileged" not in d(n), n
for n in ("repo", "release"):
    assert {"backup-model-test", "classic-session-test", "i18n-gate"} <= needs(n), n
assert "-size +95M" in d("repo")
assert "build-workspace" in needs("release") and "workspace/*.deb" in d("release")
PY
finish
