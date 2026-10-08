#!/usr/bin/env bash
# jarvis-ollama from a fake upstream tarball (contracts §7, design §5.3).
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
# Portable staging checks exercise the real fetcher without Linux/dpkg.
portable=$tmp/portable
mkdir -p "$portable/bin" "$portable/lib/ollama/cuda_v12" "$portable/lib/ollama/rocm" "$portable/lib/ollama/vulkan"
printf '#!/bin/sh\nexit 0\n' > "$portable/bin/ollama"
chmod 0755 "$portable/bin/ollama"
printf cpu > "$portable/lib/ollama/libggml-cpu-haswell.so"
chmod 0755 "$portable/lib/ollama/libggml-cpu-haswell.so"
printf base > "$portable/lib/ollama/libggml-base.so.1"
ln -s libggml-base.so.1 "$portable/lib/ollama/libggml-base.so"
printf '#!/bin/sh\nexit 0\n' > "$portable/lib/ollama/llama-server"
chmod 0755 "$portable/lib/ollama/llama-server"
printf lic > "$portable/lib/ollama/LLAMA_CPP_LICENSE"
for gpu in cuda_v12 rocm vulkan; do printf gpu > "$portable/lib/ollama/$gpu/libgpu.so"; done
printf gpu > "$portable/lib/ollama/libggml-cuda.so"
tar -C "$portable" -czf "$tmp/portable.tgz" bin lib
portable_sum=$(sha256sum "$tmp/portable.tgz" | cut -d' ' -f1)
printf 'OLLAMA_VERSION=0.0.1\nOLLAMA_ASSET=ollama-linux-amd64.tgz\nOLLAMA_SHA256=%s\n' "$portable_sum" > "$tmp/portable.env"
check "verified archive stages successfully" env OLLAMA_ENV_FILE="$tmp/portable.env" OLLAMA_TARBALL="$tmp/portable.tgz" "$PACKAGING_DIR/jarvis-ollama/stage.sh" "$tmp/stage"
check "CPU backend retained" test -f "$tmp/stage/usr/lib/ollama/libggml-cpu-haswell.so"
check "CPU libraries installed without executable bits" test ! -x "$tmp/stage/usr/lib/ollama/libggml-cpu-haswell.so"
check "private library symlink preserved" test -L "$tmp/stage/usr/lib/ollama/libggml-base.so"
check "private library symlink resolves" test -f "$tmp/stage/usr/lib/ollama/libggml-base.so"
check "llama-server runner shipped executable" test -x "$tmp/stage/usr/lib/ollama/llama-server"
check "upstream licences shipped" test -f "$tmp/stage/usr/share/doc/jarvis-ollama/licenses/LLAMA_CPP_LICENSE"
check "licences not left in the library dir" test ! -e "$tmp/stage/usr/lib/ollama/LLAMA_CPP_LICENSE"
# A release without the runner must not build (ollama cannot start models).
rm "$portable/lib/ollama/llama-server"
tar -C "$portable" -czf "$tmp/norunner.tgz" bin lib
printf 'OLLAMA_VERSION=0.0.1\nOLLAMA_ASSET=ollama-linux-amd64.tgz\nOLLAMA_SHA256=%s\n' "$(sha256sum "$tmp/norunner.tgz" | cut -d' ' -f1)" > "$tmp/norunner.env"
if env OLLAMA_ENV_FILE="$tmp/norunner.env" OLLAMA_TARBALL="$tmp/norunner.tgz" "$PACKAGING_DIR/jarvis-ollama/stage.sh" "$tmp/stage-norunner" 2>/dev/null; then
  fail "missing llama-server rejected"
else
  pass "missing llama-server rejected"
fi
for gpu in cuda_v12 rocm vulkan libggml-cuda.so; do
  check "GPU runtime excluded: $gpu" test ! -e "$tmp/stage/usr/lib/ollama/$gpu"
done
printf 'OLLAMA_VERSION=0.0.1\nOLLAMA_ASSET=ollama-linux-amd64.tgz\nOLLAMA_SHA256=%064d\n' 0 > "$tmp/portable-bad.env"
if env OLLAMA_ENV_FILE="$tmp/portable-bad.env" OLLAMA_TARBALL="$tmp/portable.tgz" "$PACKAGING_DIR/lib/fetch-ollama.sh" "$tmp/rejected" > "$tmp/error" 2>&1; then
  fail "checksum mismatch rejected"
else
  check "checksum error shows expected" grep -q expected "$tmp/error"
  check "checksum error shows actual" grep -q actual "$tmp/error"
fi
check "checksum failure does not extract" test ! -e "$tmp/rejected/bin/ollama"
mkdir -p "$tmp/portable-cache"
cp "$tmp/portable.tgz" "$tmp/portable-cache/ollama-0.0.1-ollama-linux-amd64.tgz"
env OLLAMA_TARBALL='' OLLAMA_CACHE_DIR="$tmp/portable-cache" OLLAMA_ENV_FILE="$tmp/portable-bad.env" "$PACKAGING_DIR/lib/fetch-ollama.sh" "$tmp/rejected-cache" 2>/dev/null || true
check "poisoned download cache removed" test ! -e "$tmp/portable-cache/ollama-0.0.1-ollama-linux-amd64.tgz"
check "caller-owned archive preserved" test -f "$tmp/portable.tgz"
# Removing a running package must stop the service and remove its enablement.
mkdir -p "$tmp/mock-bin"
cat > "$tmp/mock-bin/systemctl" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$SYSTEMCTL_LOG"
SH
chmod 0755 "$tmp/mock-bin/systemctl"
: > "$tmp/systemctl.log"
check "package removal succeeds" env PATH="$tmp/mock-bin:$PATH" SYSTEMCTL_LOG="$tmp/systemctl.log" sh "$PACKAGING_DIR/jarvis-ollama/postrm" remove
check "removal stops server" grep -qx 'stop ollama.service' "$tmp/systemctl.log"
check "removal disables server" grep -qx 'disable ollama.service' "$tmp/systemctl.log"
if [ "$(uname -s)" != Linux ]; then
  echo "SKIP Debian package assertions (Linux only; use dev/trixie.sh)"
  finish
  exit 0
fi
command -v gcc >/dev/null || { echo "SKIP test-ollama.sh (needs gcc libc6-dev)"; finish; exit 0; }

# A fake release: bin/ollama linked against lib/ollama/libggml-base.so, a CPU
# backend, and GPU dirs that must NOT be packaged.
up=$tmp/up; mkdir -p "$up/bin" "$up/lib/ollama/cuda_v12" "$up/lib/ollama/vulkan"
printf 'int ggml_base(void){return 0;}\n' > "$tmp/base.c"
gcc -shared -fPIC -o "$up/lib/ollama/libggml-base.so" "$tmp/base.c"
gcc -shared -fPIC -o "$up/lib/ollama/libggml-cpu-haswell.so" "$tmp/base.c"
printf 'int ggml_base(void); int main(int c,char**v){(void)v; if(c>1) return 0; return ggml_base();}\n' > "$tmp/main.c"
gcc -o "$up/bin/ollama" "$tmp/main.c" -L"$up/lib/ollama" -lggml-base -Wl,-rpath,'$ORIGIN/../lib/ollama'
gcc -o "$up/lib/ollama/llama-server" "$tmp/main.c" -L"$up/lib/ollama" -lggml-base -Wl,-rpath,'$ORIGIN'
echo cuda > "$up/lib/ollama/cuda_v12/libggml-cuda.so"; echo vk > "$up/lib/ollama/vulkan/libggml-vulkan.so"
tar -C "$up" -czf "$tmp/ollama-linux-amd64.tgz" bin lib
sum=$(sha256sum "$tmp/ollama-linux-amd64.tgz" | cut -d' ' -f1)
printf 'OLLAMA_VERSION=0.0.1\nOLLAMA_ASSET=ollama-linux-amd64.tgz\nOLLAMA_SHA256=%s\n' "$sum" > "$tmp/ollama.env"

export OLLAMA_ENV_FILE=$tmp/ollama.env OLLAMA_TARBALL=$tmp/ollama-linux-amd64.tgz
"$PACKAGING_DIR/build.sh" --out "$tmp/out" jarvis-ollama >/dev/null
deb=$tmp/out/jarvis-ollama_${OS_VERSION}_amd64.deb
check "ollama at /usr/bin" deb_has "$deb" usr/bin/ollama
check "ollama 0755" test "$(deb_mode "$deb" usr/bin/ollama)" = "-rwxr-xr-x"
check "CPU libs at /usr/lib/ollama" deb_has "$deb" usr/lib/ollama/libggml-cpu-haswell.so
check "runner at /usr/lib/ollama/llama-server" deb_has "$deb" usr/lib/ollama/llama-server
check "runner 0755" test "$(deb_mode "$deb" usr/lib/ollama/llama-server)" = "-rwxr-xr-x"
check "no CUDA runtime" bash -c "! dpkg-deb -c '$deb' | grep -q cuda_v12"
check "no Vulkan runtime" bash -c "! dpkg-deb -c '$deb' | grep -q /vulkan/"
check "private libs not leaked into Depends" bash -c "! grep -q ggml <<<\"\$(dpkg-deb -f '$deb' Depends)\""
check "libc dependency computed" grep -q 'libc6' <<<"$(deb_field "$deb" Depends)"
check "no .shlibs-libdirs shipped" test -z "$(dpkg-deb --fsys-tarfile "$deb" | tar -t | grep -F .shlibs-libdirs || true)"
check "unit shipped" deb_has "$deb" usr/lib/systemd/system/ollama.service
check "wait-ready helper" test "$(deb_mode "$deb" usr/libexec/jarvis/ollama-wait-ready)" = "-rwxr-xr-x"
unit=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/lib/systemd/system/ollama.service)
check "bound to localhost (contracts §7)" grep -qx 'Environment=OLLAMA_HOST=127.0.0.1:11434' <<<"$unit"
check "models in /var/lib/ollama" grep -qx 'Environment=OLLAMA_MODELS=/var/lib/ollama/models' <<<"$unit"
check "never runs in the live session" grep -qx 'ConditionKernelCommandLine=!boot=live' <<<"$unit"
check "runs as ollama" grep -qx 'User=ollama' <<<"$unit"
check "hardened" bash -c "grep -qx 'ProtectSystem=strict' <<<\"\$1\" && grep -qx 'NoNewPrivileges=yes' <<<\"\$1\"" _ "$unit"
check "postinst creates the user" grep -q 'adduser --system --group --home /var/lib/ollama' <<<"$(deb_script "$deb" postinst)"
check "postinst enables the unit offline" grep -q 'systemctl enable ollama.service' <<<"$(deb_script "$deb" postinst)"
check "version recorded" grep -q '0.0.1' <<<"$(dpkg-deb --fsys-tarfile "$deb" | tar -xO ./usr/share/doc/jarvis-ollama/UPSTREAM)"

printf 'OLLAMA_VERSION=0.0.1\nOLLAMA_ASSET=ollama-linux-amd64.tgz\nOLLAMA_SHA256=%064d\n' 0 > "$tmp/bad.env"
err=$(OLLAMA_ENV_FILE=$tmp/bad.env "$PACKAGING_DIR/build.sh" --out "$tmp/o2" jarvis-ollama 2>&1 || true)
check "checksum mismatch fails" test ! -e "$tmp/o2/jarvis-ollama_${OS_VERSION}_amd64.deb"
check "error shows both sums" bash -c "grep -q expected <<<\"\$1\" && grep -q actual <<<\"\$1\"" _ "$err"
mkdir -p "$tmp/cache"; cp "$tmp/ollama-linux-amd64.tgz" "$tmp/cache/ollama-0.0.1-ollama-linux-amd64.tgz"
OLLAMA_TARBALL='' OLLAMA_CACHE_DIR=$tmp/cache OLLAMA_ENV_FILE=$tmp/bad.env "$PACKAGING_DIR/lib/fetch-ollama.sh" "$tmp/x" 2>/dev/null || true
check "poisoned cache entry deleted" test ! -e "$tmp/cache/ollama-0.0.1-ollama-linux-amd64.tgz"
for s in postinst postrm; do check "$s is POSIX sh" sh -n "$PACKAGING_DIR/jarvis-ollama/$s"; done
finish
