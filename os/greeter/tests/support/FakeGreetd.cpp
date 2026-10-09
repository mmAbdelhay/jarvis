#include "FakeGreetd.h"

#include <QLocalSocket>

using namespace Qt::StringLiterals;
using jarvis::greeter::encodeGreetd;

FakeGreetd::FakeGreetd()
{
    QObject::connect(&m_server, &QLocalServer::newConnection, this, [this] { onConnection(); });
}

FakeGreetd::~FakeGreetd()
{
    dropClients();
}

bool FakeGreetd::listen()
{
    QLocalServer::removeServer(socketPath());
    return m_server.listen(socketPath());
}

QString FakeGreetd::socketPath() const
{
    return m_dir.filePath(u"greetd.sock"_s);
}

void FakeGreetd::dropClients()
{
    for (Peer* peer : std::as_const(m_peers)) {
        peer->socket->abort();
        peer->socket->deleteLater();
        delete peer;
    }
    m_peers.clear();
}

QJsonObject FakeGreetd::success() { return {{"type", "success"}}; }
QJsonObject FakeGreetd::error(const QString& type, const QString& description)
{
    return {{"type", "error"}, {"error_type", type}, {"description", description}};
}
QJsonObject FakeGreetd::prompt(const QString& type, const QString& text)
{
    return {{"type", "auth_message"}, {"auth_message_type", type}, {"auth_message", text}};
}

void FakeGreetd::onConnection()
{
    while (QLocalSocket* socket = m_server.nextPendingConnection()) {
        auto* peer = new Peer;
        peer->socket = socket;
        m_peers.append(peer);
        QObject::connect(socket, &QLocalSocket::readyRead, this, [this, peer] { onData(peer); });
    }
}

void FakeGreetd::send(Peer* peer, const QJsonObject& response)
{
    peer->socket->write(encodeGreetd(response));
}

void FakeGreetd::onData(Peer* peer)
{
    peer->decoder.feed(peer->socket->readAll());
    while (auto request = peer->decoder.next()) {
        received.append(*request);
        handle(peer, *request);
        if (!m_peers.contains(peer))
            return; // dropped while handling
    }
}

void FakeGreetd::handle(Peer* peer, const QJsonObject& request)
{
    const QString type = request.value("type").toString();
    if (type == u"create_session") {
        if (dropOnCreate) {
            m_peers.removeAll(peer);
            peer->socket->abort();
            peer->socket->deleteLater();
            delete peer;
            return;
        }
        if (peer->stage != Stage::None)
            return send(peer, error(u"error"_s, u"a session is already being configured"_s));
        peer->user = request.value("username").toString();
        if (!infoMessage.isEmpty()) {
            peer->stage = Stage::Info;
            return send(peer, prompt(u"info"_s, infoMessage));
        }
        peer->stage = Stage::Password;
        return send(peer, prompt(u"secret"_s, u"Password:"_s));
    }
    if (type == u"post_auth_message_response") {
        const QString answer = request.value("response").toString();
        switch (peer->stage) {
        case Stage::Info:
            peer->stage = Stage::Password;
            return send(peer, prompt(u"secret"_s, u"Password:"_s));
        case Stage::Password:
            if (!passwords.contains(peer->user) || passwords.value(peer->user) != answer) {
                peer->stage = Stage::Failed;
                return send(peer, error(u"auth_error"_s, u"pam_authenticate: AUTH_ERR"_s));
            }
            if (!extraPrompt.isEmpty()) {
                peer->stage = Stage::Extra;
                return send(peer, prompt(u"visible"_s, extraPrompt));
            }
            peer->stage = Stage::Authed;
            return send(peer, success());
        case Stage::Extra:
            peer->stage = answer == extraAnswer ? Stage::Authed : Stage::Failed;
            return send(peer, peer->stage == Stage::Authed ? success() : error(u"auth_error"_s, u"wrong code"_s));
        default:
            return send(peer, error(u"error"_s, u"no auth message pending"_s));
        }
    }
    if (type == u"start_session") {
        if (peer->stage != Stage::Authed)
            return send(peer, error(u"error"_s, u"session not authenticated"_s));
        return send(peer, startError.isEmpty() ? success() : error(u"error"_s, startError));
    }
    if (type == u"cancel_session") {
        peer->stage = Stage::None;
        peer->user.clear();
        return send(peer, success());
    }
    send(peer, error(u"error"_s, u"unknown request"_s));
}
