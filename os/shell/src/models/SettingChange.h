#pragma once

#include <QString>
#include <optional>
#include <utility>

// "previous → current" in a settings.* card item detail or tool summary
// (Rafiq M3 design §3.1: every setter reports {previous, current}). Anything
// else is not a change and renders as ordinary text.
std::optional<std::pair<QString, QString>> settingChange(const QString& tool, const QString& text);
