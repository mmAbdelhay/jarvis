#include "protocol/BuildId.h"

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>

using namespace Qt::StringLiterals;

namespace jarvis::protocol {

QString formatBuildId(const QString& version, const std::optional<QString>& commit, const QString& builtAt)
{
    const QString id = version + u'+' + commit.value_or(u"nogit"_s) + u'.' + builtAt;
    return id.left(kMaxBuildLength);
}

QString readBuildId(const QString& stampPath)
{
    QFile file(stampPath);
    if (!file.open(QIODevice::ReadOnly))
        return u"dev"_s;
    QJsonParseError error{};
    const QJsonDocument document = QJsonDocument::fromJson(file.readAll(), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject())
        return u"dev"_s;
    const QJsonObject stamp = document.object();
    if (stamp.contains("build")) {
        const QString build = stamp.value("build").toString();
        return build.isEmpty() ? u"dev"_s : build.left(kMaxBuildLength);
    }
    if (!stamp.value("version").isString() || !stamp.value("builtAt").isString())
        return u"dev"_s;
    std::optional<QString> commit;
    if (stamp.contains("commit")) {
        if (!stamp.value("commit").isString())
            return u"dev"_s;
        commit = stamp.value("commit").toString();
    }
    return formatBuildId(stamp.value("version").toString(), commit, stamp.value("builtAt").toString());
}

QString defaultBuildStampPath()
{
    const QString overridden = qEnvironmentVariable("JARVIS_BUILD_STAMP");
    return overridden.isEmpty() ? u"/usr/lib/jarvis/daemon/build-stamp.json"_s : overridden;
}

} // namespace jarvis::protocol
