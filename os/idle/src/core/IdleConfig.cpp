#include "core/IdleConfig.h"

#include <QDir>
#include <QFile>
#include <QRegularExpression>
#include <QStringList>
#include <algorithm>
#include <optional>

using namespace Qt::StringLiterals;

namespace {
std::optional<int> parseInt(QString value)
{
    value = value.trimmed();
    if (value.size() >= 2 && (value.front() == u'"' || value.front() == u'\'') && value.back() == value.front())
        value = value.mid(1, value.size() - 2);
    bool ok = false;
    const int n = value.toInt(&ok);
    return ok ? std::optional<int>(n) : std::nullopt;
}
} // namespace

int lockAfterMinutesFromText(const QString& yaml)
{
    struct Level {
        qsizetype indent;
        QString key;
    };
    static const QRegularExpression keyLine(u"^( *)([A-Za-z_][A-Za-z0-9_-]*)\\s*:\\s*(.*)$"_s);
    static const QRegularExpression flow(u"lockAfterMinutes\\s*:\\s*([^,}\\s]+)"_s);
    QList<Level> stack;
    std::optional<int> found;
    for (QString line : yaml.split(u'\n')) {
        if (const qsizetype hash = line.indexOf(u" #"); hash >= 0)
            line.truncate(hash);
        if (line.trimmed().isEmpty() || line.trimmed().startsWith(u'#'))
            continue;
        const QRegularExpressionMatch m = keyLine.match(line);
        if (!m.hasMatch())
            continue;
        const qsizetype indent = m.captured(1).size();
        const QString key = m.captured(2);
        const QString value = m.captured(3).trimmed();
        while (!stack.isEmpty() && stack.constLast().indent >= indent)
            stack.removeLast();
        QStringList path;
        for (const Level& level : std::as_const(stack))
            path.append(level.key);
        const bool idleParent = path.isEmpty() || path == QStringList{u"os"_s};
        const bool underIdle = path == QStringList{u"idle"_s} || path == QStringList{u"os"_s, u"idle"_s};
        if (key == u"lockAfterMinutes" && underIdle) {
            found = parseInt(value);
            if (!found)
                return kDefaultLockAfterMinutes;
            continue;
        }
        if (key == u"idle" && idleParent && value.startsWith(u'{')) {
            const QRegularExpressionMatch f = flow.match(value);
            if (f.hasMatch())
                found = parseInt(f.captured(1));
            continue;
        }
        if (value.isEmpty())
            stack.append({indent, key});
    }
    return found ? std::clamp(*found, 0, 240) : kDefaultLockAfterMinutes;
}

int lockAfterMinutes(const QString& yamlPath)
{
    QFile file(yamlPath);
    if (!file.open(QIODevice::ReadOnly) || file.size() > 1024 * 1024)
        return kDefaultLockAfterMinutes;
    return lockAfterMinutesFromText(QString::fromUtf8(file.readAll()));
}

QString defaultConfigPath()
{
    QString base = qEnvironmentVariable("XDG_CONFIG_HOME");
    if (base.isEmpty())
        base = QDir::homePath() + u"/.config"_s;
    return base + u"/jarvis/jarvis.yaml"_s;
}
