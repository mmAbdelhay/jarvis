#include "models/SettingChange.h"

using namespace Qt::StringLiterals;

namespace {
constexpr qsizetype kMaxSide = 80;

bool usable(const QString& side)
{
    return !side.isEmpty() && side.size() <= kMaxSide && !side.contains(u'\n') && !side.contains(u'\r');
}
} // namespace

std::optional<std::pair<QString, QString>> settingChange(const QString& tool, const QString& text)
{
    if (!tool.startsWith(u"settings."_s) && !tool.startsWith(u"settings_"_s))
        return std::nullopt;
    if (text.contains(u'\n') || text.contains(u'\r'))
        return std::nullopt;
    static const QString arrow = u" → "_s;
    const qsizetype at = text.indexOf(arrow);
    if (at < 0 || text.indexOf(arrow, at + arrow.size()) >= 0)
        return std::nullopt;
    const QString from = text.left(at).trimmed();
    const QString to = text.mid(at + arrow.size()).trimmed();
    if (!usable(from) || !usable(to))
        return std::nullopt;
    return std::pair{from, to};
}
