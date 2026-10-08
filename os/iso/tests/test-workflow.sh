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
check "M2.5 CI version" grep -qF "'0.2.5~ci{0}'" "$wf"
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
assert "ghcr.io/mmabdelhay/jarvis-agent:$OS_VERSION" in d("docker-publish")
assert set(j["release"]["needs"]) >= {"agent-install", "docker-publish", "repo"}
assert set(j["repo"]["needs"]) >= {"agent-install", "docker-image"}
repo = d("repo")
for s in ("build_index.py", "sign-index.sh", "verify-index.sh", "--verify-remote", "--previous"):
    assert s in repo, s
assert repo.index("build-repo.sh") < repo.index("build_index.py") < repo.index("sign-index.sh") < repo.rindex("publish.sh")
assert "JARVIS_RELEASE" in repo
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
finish
