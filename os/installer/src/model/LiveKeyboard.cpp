#include "LiveKeyboard.h"

#include <QDir>
#include <QFile>
#include <QProcess>
#include <QRegularExpression>
#include <QSaveFile>

using namespace Qt::StringLiterals;

LiveKeyboard::LiveKeyboard(const QString& userConfigDir, const QString& systemEnvironmentFile,
                           const QStringList& reconfigureCommand, QObject* parent)
    : QObject(parent)
    , m_userConfigDir(userConfigDir)
    , m_systemFile(systemEnvironmentFile)
    , m_command(reconfigureCommand)
{
}

bool LiveKeyboard::apply(const QString& keyboard)
{
    // Only XKB names reach the file: nothing else can add a line to it.
    static const QRegularExpression valid(u"\\A([a-z0-9_-]+)(?:\\(([a-z0-9_-]+)\\))?\\z"_s);
    const QRegularExpressionMatch m = valid.match(keyboard);
    if (!m.hasMatch() || m_command.isEmpty())
        return false;

    QByteArray out;
    QFile system(m_systemFile);
    if (system.open(QIODevice::ReadOnly)) {
        for (const QByteArray& line : system.readAll().split('\n')) {
            if (line.isEmpty() || line.startsWith("XKB_DEFAULT_LAYOUT=") || line.startsWith("XKB_DEFAULT_VARIANT="))
                continue;
            out += line + '\n';
        }
    }
    out += "XKB_DEFAULT_LAYOUT=" + m.captured(1).toLatin1() + '\n';
    out += "XKB_DEFAULT_VARIANT=" + m.captured(2).toLatin1() + '\n';

    const QString dir = m_userConfigDir + u"/labwc"_s;
    if (!QDir().mkpath(dir))
        return false;
    QSaveFile file(dir + u"/environment"_s);
    if (!file.open(QIODevice::WriteOnly) || file.write(out) != out.size() || !file.commit())
        return false;

    QProcess reconfigure;
    reconfigure.setProcessChannelMode(QProcess::ForwardedChannels);
    reconfigure.start(m_command.constFirst(), m_command.mid(1));
    if (!reconfigure.waitForFinished(3000)) {
        reconfigure.kill();
        reconfigure.waitForFinished(500);
        return false;
    }
    return reconfigure.exitStatus() == QProcess::NormalExit && reconfigure.exitCode() == 0;
}
