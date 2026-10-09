#include "GreetdClient.h"

#include <QLocalSocket>
#include <QTimer>

using namespace Qt::StringLiterals;

GreetdClient::GreetdClient(QString socketPath, QObject* parent)
    : QObject(parent)
    , m_path(std::move(socketPath))
    , m_socket(new QLocalSocket(this))
{
    connect(m_socket, &QLocalSocket::connected, this, &GreetdClient::flush);
    connect(m_socket, &QLocalSocket::readyRead, this, &GreetdClient::onReadyRead);
    connect(m_socket, &QLocalSocket::errorOccurred, this, [this](QLocalSocket::LocalSocketError error) {
        const bool notRunning = error == QLocalSocket::ServerNotFoundError || error == QLocalSocket::ConnectionRefusedError;
        fail(notRunning ? tr("The login service isn't running.") : tr("Lost the connection to the login service."));
    });
    connect(m_socket, &QLocalSocket::disconnected, this, [this] { fail(tr("Lost the connection to the login service.")); });
}

QString GreetdClient::socketPathFromEnvironment()
{
    return qEnvironmentVariable("GREETD_SOCK");
}

void GreetdClient::send(const QJsonObject& request)
{
    ++m_outstanding;
    if (m_path.isEmpty()) {
        QTimer::singleShot(0, this, [this] { fail(tr("The login service isn't running.")); });
        return;
    }
    m_queue.append(jarvis::greeter::encodeGreetd(request));
    if (m_socket->state() == QLocalSocket::ConnectedState)
        flush();
    else if (m_socket->state() == QLocalSocket::UnconnectedState) {
        m_decoder = {};
        m_socket->connectToServer(m_path);
    }
}

void GreetdClient::reset()
{
    m_queue.clear();
    m_outstanding = 0;
    m_socket->abort();
}

void GreetdClient::flush()
{
    for (QByteArray& frame : m_queue) {
        m_socket->write(frame);
        frame.fill('\0'); // may hold a password
    }
    m_queue.clear();
}

void GreetdClient::onReadyRead()
{
    m_decoder.feed(m_socket->readAll());
    while (auto message = m_decoder.next()) {
        m_outstanding = std::max(0, m_outstanding - 1);
        emit response(*message);
    }
    if (m_decoder.failed())
        fail(tr("The login service sent something unreadable."));
}

void GreetdClient::fail(const QString& message)
{
    if (m_outstanding == 0 && m_queue.isEmpty())
        return; // nothing was waiting: a quiet close between logins
    m_queue.clear();
    m_outstanding = 0;
    m_socket->abort();
    emit failed(message);
}
