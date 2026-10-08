#pragma once

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QString>

// The public distro name (os-release(5) NAME), read in exactly one place so
// a rename needs no code change. Tests set JARVIS_OS_RELEASE.
namespace jarvis::ui {

inline QString osReleasePath()
{
    const QString env = qEnvironmentVariable("JARVIS_OS_RELEASE");
    return env.isEmpty() ? QStringLiteral("/etc/os-release") : env;
}

inline QString distroName(const QString& path = osReleasePath())
{
    const QString fallback = QStringLiteral("Rafiq");
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return fallback;
    while (!file.atEnd()) {
        const QString line = QString::fromUtf8(file.readLine()).trimmed();
        if (!line.startsWith(QLatin1String("NAME=")))
            continue;
        QString value = line.mid(5);
        if (value.size() >= 2 && (value.front() == u'"' || value.front() == u'\'') && value.back() == value.front())
            value = value.mid(1, value.size() - 2);
        QString out;
        for (qsizetype i = 0; i < value.size(); ++i) {
            if (value[i] == u'\\' && i + 1 < value.size())
                ++i; // os-release(5): \" \\ \$ \` are escapes
            out.append(value[i]);
        }
        out = out.trimmed();
        return out.isEmpty() ? fallback : out;
    }
    return fallback;
}

// M4 contracts §6.8: jarvis-branding ships {"name": {"en": ..., "ar": ...}}
// here. Tests set JARVIS_BRAND_JSON.
inline QString brandPath()
{
    const QString env = qEnvironmentVariable("JARVIS_BRAND_JSON");
    return env.isEmpty() ? QStringLiteral("/usr/share/jarvis/brand.json") : env;
}

// The distro name in `lang` for UI text: brand.json name[lang] when it is a
// non-blank string, else os-release NAME (distroName above).
inline QString localizedDistroName(const QString& lang, const QString& brand = brandPath(),
                                   const QString& osRelease = osReleasePath())
{
    QFile file(brand);
    if (file.open(QIODevice::ReadOnly)) {
        const QJsonValue name = QJsonDocument::fromJson(file.read(64 * 1024)).object().value(QLatin1String("name"));
        const QString value = name.toObject().value(lang).toString().trimmed();
        if (!value.isEmpty())
            return value;
    }
    return distroName(osRelease);
}

} // namespace jarvis::ui
