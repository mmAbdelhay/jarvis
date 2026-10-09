#!/usr/bin/env bash
# jarvis-backup-model (M4 contracts §1) from a mirror fixture. With
# JARVIS_DPKG_INSTALL_TESTS=1 as root (a throwaway container) it also installs
# the package and checks the store stays writable by ollama (Review Focus 1).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
fx=$tmp/fixture
python3 - "$fx" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
parts = [("application/vnd.docker.container.image.v1+json", b'{"model_format":"gguf"}'),
         ("application/vnd.ollama.image.model", b"GGUF" + bytes(2048)),
         ("application/vnd.ollama.image.license", b"Apache-2.0")]
d = lambda b: "sha256:" + hashlib.sha256(b).hexdigest()
desc = [{"mediaType": m, "digest": d(b), "size": len(b)} for m, b in parts]
manifest = json.dumps({"schemaVersion": 2, "config": desc[0], "layers": desc[1:]}).encode()
mirror = root / "mirror"
(mirror / "blobs").mkdir(parents=True)
for _, b in parts:
    (mirror / "blobs" / d(b).replace(":", "-")).write_bytes(b)
mp = mirror / "manifests/registry.ollama.ai/library/tiny/1b"
mp.parent.mkdir(parents=True)
mp.write_bytes(manifest)
(root / "model-blob").write_text(str(mirror / "blobs" / d(parts[1][1]).replace(":", "-")))
(root / "catalog.json").write_text(json.dumps({"version": 1, "models": [
    {"id": "tiny-1b", "ollamaTag": "tiny:1b", "sizeBytes": sum(len(b) for _, b in parts), "role": "backup"}]}))
(root / "lock.json").write_text(json.dumps({"version": 1, "ollamaTag": "tiny:1b",
    "manifest": {"sha256": hashlib.sha256(manifest).hexdigest(), "size": len(manifest)}, "blobs": desc}))
PY
export BACKUP_MODEL_MIRROR=$fx/mirror BACKUP_MODEL_CATALOG=$fx/catalog.json BACKUP_MODEL_LOCK=$fx/lock.json \
  BACKUP_MODEL_CACHE_DIR=$tmp/cache
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-backup-model >/dev/null
deb=$tmp/out/jarvis-backup-model_${OS_VERSION}_all.deb
store=var/lib/ollama/models
model_blob=$store/blobs/$(basename "$(cat "$fx/model-blob")")
check "manifest where ollama looks for tiny:1b" deb_has "$deb" "$store/manifests/registry.ollama.ai/library/tiny/1b"
check "three blobs" test "$(deb_list "$deb" | awk '{print $6}' | grep -c "^\./$store/blobs/sha256-")" -eq 3
check "weights are world-readable" test "$(deb_mode "$deb" "$model_blob")" = "-rw-r--r--"
check "Architecture all" test "$(deb_field "$deb" Architecture)" = all
check "Depends exactly jarvis-ollama, unversioned (too big for the APT repo)" test "$(deb_field "$deb" Depends)" = jarvis-ollama
check "data stored uncompressed (GGUF does not compress)" grep -qx data.tar <<<"$(ar t "$deb")"
check "MODEL doc names the tag" grep -q 'tiny:1b' <<<"$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/doc/jarvis-backup-model/MODEL)"
check "postinst shipped" test "$(deb_script_mode "$deb" postinst)" = "-rwxr-xr-x"

# Weights that are not the pinned bytes fail the build and leave no .deb.
printf 'x' >> "$(cat "$fx/model-blob")"
err=$("$PACKAGING_DIR/build.sh" --out "$tmp/bad" jarvis-backup-model 2>&1 || true)
check "tampered weights fail the build" test ! -e "$tmp/bad/jarvis-backup-model_${OS_VERSION}_all.deb"
check "the error says the bytes do not match the lock" grep -q 'does not match the lock' <<<"$err"

if [ "${JARVIS_DPKG_INSTALL_TESTS:-0}" = 1 ] && [ "$(id -u)" = 0 ]; then
  getent passwd ollama >/dev/null ||
    useradd --system --user-group --home-dir /var/lib/ollama --no-create-home --shell /usr/sbin/nologin ollama
  install -d -o ollama -g ollama /var/lib/ollama /var/lib/ollama/models   # as jarvis-ollama's postinst does
  dpkg --force-depends -i "$deb" >/dev/null 2>&1
  for d in /var/lib/ollama /var/lib/ollama/models /var/lib/ollama/models/blobs \
    /var/lib/ollama/models/manifests/registry.ollama.ai/library/tiny; do
    check "$d owned by ollama" test "$(stat -c %U "$d")" = ollama
  done
  check "ollama can add a model next to it (installer / first-boot pull)" \
    runuser -u ollama -- mkdir /var/lib/ollama/models/blobs/.pull-test
  rmdir /var/lib/ollama/models/blobs/.pull-test
  dpkg --purge jarvis-backup-model >/dev/null 2>&1
  # A store the ollama user replaced by a symlink is never followed.
  deb_script "$deb" postinst > "$tmp/postinst"
  rm -rf /var/lib/ollama/models
  install -d -o ollama -g ollama /var/lib/ollama
  install -d -m0755 /root/trap/blobs
  ln -s /root/trap /var/lib/ollama/models
  sh "$tmp/postinst" configure
  check "postinst never chowns through a symlinked store" test "$(stat -c %U /root/trap/blobs)" = root
  rm /var/lib/ollama/models; rm -rf /root/trap
else
  echo "SKIP install checks (JARVIS_DPKG_INSTALL_TESTS=1 as root in a throwaway container)" >&2
fi
finish
