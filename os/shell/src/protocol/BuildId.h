#pragma once

// jarvisd answers restart-required to a hello whose build differs from its
// own, so the shell sends the daemon's build id, read from the build stamp
// jarvisd ships with (contracts §6.6: {"build": string} at
// /usr/lib/jarvis/daemon/build-stamp.json). The app-style stamp of
// packages/desktop/src/daemon/build-id.ts ({version, commit?, builtAt}) is
// accepted too, so a dev build works.

#include <QString>
#include <optional>

namespace jarvis::protocol {

inline constexpr qsizetype kMaxBuildLength = 256;

// `${version}+${commit ?? "nogit"}.${builtAt}`, cut to 256 UTF-16 units.
QString formatBuildId(const QString& version, const std::optional<QString>& commit, const QString& builtAt);

// The build id from a build-stamp.json: its non-empty "build" string (cut to
// 256), else the formatted app-style stamp, else "dev".
QString readBuildId(const QString& stampPath);

// $JARVIS_BUILD_STAMP, else /usr/lib/jarvis/daemon/build-stamp.json (the
// jarvisd package's install dir, contracts §4).
QString defaultBuildStampPath();

} // namespace jarvis::protocol
