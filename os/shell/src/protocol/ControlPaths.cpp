#include "protocol/ControlPaths.h"

#include <QDir>

using namespace Qt::StringLiterals;

namespace jarvis::protocol {

ControlPaths controlPaths(const QString& runDirectory)
{
    const QDir dir(runDirectory);
    return {runDirectory, dir.filePath(u"jarvisd.sock"_s), dir.filePath(u"control.secret"_s)};
}

QString defaultRunDirectory()
{
    const QString overridden = qEnvironmentVariable("JARVIS_RUN_DIR");
    if (!overridden.isEmpty())
        return overridden;
    return QDir::homePath() + u"/.config/jarvis/run"_s;
}

} // namespace jarvis::protocol
