#!/bin/sh
# make-fixture.sh DIR — DIR/beach.xcf (640x480, sky over sand) for the
# computer-use GUI tests: png.mjs draws a PNG, GIMP's batch mode saves it as
# XCF. GIMP 3.0's Script-Fu signatures are tried in order; the first one that
# writes an XCF wins. Env: JARVIS_NODE (default: the jarvisd package's Node).
set -eu
dir=$1
here=$(cd "$(dirname "$0")" && pwd)
node=${JARVIS_NODE:-/usr/lib/jarvis/node/bin/node}
mkdir -p "$dir"
"$node" --input-type=module - "$here/png.mjs" "$dir/beach.png" <<'JS'
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { encodePng } = await import(pathToFileURL(process.argv[2]).href);
writeFileSync(process.argv[3], encodePng(640, 480, (x, y) => (y < 300 ? [80 + (y >> 2), 160, 230] : [230, 200, 140])));
JS
# Escape paths as Script-Fu string literals, independently of shell quoting.
scheme_dir=$("$node" -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1, -1))' "$dir")

gimp_console=$(command -v gimp-console || command -v gimp-console-3.0 || true)
[ -n "$gimp_console" ] || { echo "make-fixture: gimp-console not found" >&2; exit 1; }
for form in \
  "(gimp-xcf-save RUN-NONINTERACTIVE image \"$scheme_dir/beach.xcf\")" \
  "(gimp-file-save RUN-NONINTERACTIVE image \"$scheme_dir/beach.xcf\" -1)"; do
  rm -f "$dir/beach.xcf"
  "$gimp_console" -i -n -d -f --batch-interpreter=plug-in-script-fu-eval \
    -b "(let* ((image (car (gimp-file-load RUN-NONINTERACTIVE \"$scheme_dir/beach.png\")))) $form)" \
    -b '(gimp-quit 0)' > "$dir/make-fixture.log" 2>&1 || true
  if [ "$(head -c 9 "$dir/beach.xcf" 2>/dev/null)" = "gimp xcf " ]; then
    rm -f "$dir/beach.png" "$dir/make-fixture.log"
    exit 0
  fi
done
echo "make-fixture: GIMP did not write $dir/beach.xcf; its log:" >&2
cat "$dir/make-fixture.log" >&2
exit 1
