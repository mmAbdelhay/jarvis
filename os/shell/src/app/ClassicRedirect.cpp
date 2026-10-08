#include "app/ClassicRedirect.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QSaveFile>

#ifdef Q_OS_UNIX
#include <unistd.h>
#endif

using namespace Qt::StringLiterals;

namespace jarvis::shell {

QString classicMarkerPath()
{
    QString runtime = qEnvironmentVariable("XDG_RUNTIME_DIR");
#ifdef Q_OS_UNIX
    if (runtime.isEmpty())
        runtime = u"/run/user/%1"_s.arg(::getuid());
#endif
    return runtime + u"/jarvis/classic-fallback"_s;
}

bool redirectToClassic(const QString& markerPath,
                       const std::function<bool(const QString& program, const QStringList& args)>& start)
{
    if (!QFileInfo::exists(markerPath))
        return false;
    return start(u"jarvis-classic"_s, {u"--chat"_s});
}

bool writeClassicMarker(const QString& markerPath, const QString& reason, qint64 since)
{
    const QFileInfo info(markerPath);
    const QString dir = info.absolutePath();
    if (!QDir().mkpath(dir))
        return false;
    if (!QFile::setPermissions(dir, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner))
        return false;
    QSaveFile file(markerPath);
    if (!file.open(QIODevice::WriteOnly))
        return false;
    file.write(u"reason=%1\nsince=%2\n"_s.arg(reason).arg(since).toUtf8());
    return file.commit();
}

} // namespace jarvis::shell
