#include "app/SingleInstance.h"

#include <QDir>
#include <QLocalSocket>

#ifdef Q_OS_UNIX
#include <unistd.h>
#endif

using namespace Qt::StringLiterals;

SingleInstance::SingleInstance(QString name, QObject* parent)
    : QObject(parent)
    , m_name(std::move(name))
{
    connect(&m_server, &QLocalServer::newConnection, this, [this] {
        while (QLocalSocket* socket = m_server.nextPendingConnection()) {
            connect(socket, &QLocalSocket::readyRead, this, [this, socket] {
                if (!socket->canReadLine())
                    return;
                emit messageReceived(socket->readLine(64).trimmed());
                socket->disconnectFromServer();
            });
            connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
        }
    });
}

QString SingleInstance::defaultName()
{
    const QString runtime = qEnvironmentVariable("XDG_RUNTIME_DIR");
    if (!runtime.isEmpty())
        return runtime + u"/jarvis-shell.sock"_s;
#ifdef Q_OS_UNIX
    return QDir::tempPath() + u"/jarvis-shell-%1.sock"_s.arg(::getuid());
#else
    return QDir::tempPath() + u"/jarvis-shell.sock"_s;
#endif
}

bool SingleInstance::forward(const QByteArray& message, int timeoutMs)
{
    QLocalSocket socket;
    socket.connectToServer(m_name);
    if (!socket.waitForConnected(timeoutMs))
        return false;
    socket.write(message + '\n');
    const bool written = socket.waitForBytesWritten(timeoutMs);
    socket.disconnectFromServer();
    return written;
}

bool SingleInstance::listen()
{
    QLocalServer::removeServer(m_name); // only reached when forward() found nobody: the file is stale
    m_server.setSocketOptions(QLocalServer::UserAccessOption);
    return m_server.listen(m_name);
}
