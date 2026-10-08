#include "app/ClassicRedirect.h"

#include <QFileInfo>

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

} // namespace jarvis::shell
