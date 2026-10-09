#pragma once

#include <QString>

// idle.lockAfterMinutes (Rafiq M3 contracts §3, default 10) from jarvis.yaml:
// a top-level `idle:` block or `os: idle:`, block or flow style. 0 turns
// idle locking off; values are clamped to 0..240; anything unreadable gives
// the default. A tiny reader on purpose: no YAML library for one integer.
inline constexpr int kDefaultLockAfterMinutes = 10;
int lockAfterMinutes(const QString& yamlPath);
int lockAfterMinutesFromText(const QString& yaml);
QString defaultConfigPath();
