#include "SessionChoice.h"

#include <QFileInfo>
#include <QStandardPaths>
#include <algorithm>

#include "DesktopEntry.h"

using namespace Qt::StringLiterals;

QString SessionEntry::name(const QString& lang) const
{
    jarvis::ui::DesktopEntry entry;
    entry.names = names;
    return entry.name(lang);
}

namespace {
bool tryExecResolves(const QString& tryExec)
{
    if (tryExec.isEmpty())
        return true;
    if (tryExec.startsWith(u'/'))
        return QFileInfo(tryExec).isFile() && QFileInfo(tryExec).isExecutable();
    return !QStandardPaths::findExecutable(tryExec).isEmpty();
}
int rank(const QString& id)
{
    return id == u"rafiq" ? 0 : id == u"rafiq-classic" ? 1 : 2;
}
} // namespace

QList<SessionEntry> readSessions(const QString& dir)
{
    QList<SessionEntry> out;
    for (const jarvis::ui::DesktopEntry& e : jarvis::ui::readDesktopEntries({dir})) {
        if ((!e.type.isEmpty() && e.type != u"Application") || e.hidden || e.noDisplay || !tryExecResolves(e.tryExec))
            continue;
        const auto argv = jarvis::ui::splitExec(e.exec);
        if (!argv)
            continue;
        out.append({e.id, e.names, *argv});
    }
    std::stable_sort(out.begin(), out.end(), [](const SessionEntry& a, const SessionEntry& b) {
        if (rank(a.id) != rank(b.id))
            return rank(a.id) < rank(b.id);
        return QString::compare(a.name(u"en"_s), b.name(u"en"_s), Qt::CaseSensitive) < 0;
    });
    return out;
}
