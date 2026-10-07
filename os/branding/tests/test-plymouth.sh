#!/usr/bin/env bash
# The Plymouth theme files, and the pixel contract the install tests rely on.
source "$(dirname "$0")/lib.sh"
tmp=$(mktmp); trap 'rm -rf "$tmp"' EXIT
"$BRANDING_DIR/render.sh" "$tmp/root" >/dev/null
t=$tmp/root/usr/share/plymouth/themes/jarvis
for f in jarvis.plymouth jarvis.script logo.png entry.png bullet.png; do check "theme has $f" test -f "$t/$f"; done
check "script plugin" grep -qx 'ModuleName=script' "$t/jarvis.plymouth"
check "script path" grep -qx 'ScriptFile=/usr/share/plymouth/themes/jarvis/jarvis.script' "$t/jarvis.plymouth"
check "theme name is the brand" grep -qx 'Name=Rafiq' "$t/jarvis.plymouth"
check "password prompt handled" grep -q 'Plymouth.SetDisplayPasswordFunction' "$t/jarvis.script"
check "normal mode hides the prompt" grep -q 'Plymouth.SetDisplayNormalFunction' "$t/jarvis.script"
check "messages shown (retry text)" grep -q 'Plymouth.SetMessageFunction' "$t/jarvis.script"
check "prompt names the brand" grep -q 'Unlock Rafiq' "$t/jarvis.script"
check "bad passphrase gets a plain retry line" grep -q "That passphrase didn't work. Try again." "$t/jarvis.script"
check "no placeholder left" bash -c "! grep -q '@DISTRO' '$t/jarvis.script' '$t/jarvis.plymouth'"
python3 - "$t/entry.png" "$t/bullet.png" <<'PY' && pass "entry/bullet pixel contract" || fail "entry/bullet pixel contract"
import struct, sys, zlib
def decode(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n"
    pos, idat, w = 8, b"", 0
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8]); body = data[pos + 8:pos + 8 + n]; pos += 12 + n
        if kind == b"IHDR": w, h, depth, ctype = struct.unpack(">IIBB", body[:10]); assert depth == 8 and ctype in (2, 6)
        if kind == b"IDAT": idat += body
    bpp = 4 if ctype == 6 else 3
    raw, rows, prev, i = zlib.decompress(idat), [], bytearray(w * bpp), 0
    for _ in range(h):
        f, line = raw[i], bytearray(raw[i + 1:i + 1 + w * bpp]); i += 1 + w * bpp
        for x in range(len(line)):
            a = line[x - bpp] if x >= bpp else 0; b = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
            line[x] = (line[x] + (0, a, b, (a + b) // 2, a if pa <= pb and pa <= pc else b if pb <= pc else c)[f]) & 255
        rows.append(line); prev = line
    return w, h, lambda x, y: tuple(rows[y][x * bpp:x * bpp + 3])
w, h, px = decode(sys.argv[1])
assert (w, h) == (480, 48), (w, h)
assert px(0, 0) == px(479, 47) == px(240, 1) == (0x4F, 0xD8, 0xC4), px(240, 1)
assert px(240, 24) == (0x15, 0x1A, 0x20), px(240, 24)
w, h, px = decode(sys.argv[2])
assert (w, h) == (12, 12) and px(6, 6) == (0xE7, 0xEA, 0xEE)
PY
finish
