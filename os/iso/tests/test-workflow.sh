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
finish
