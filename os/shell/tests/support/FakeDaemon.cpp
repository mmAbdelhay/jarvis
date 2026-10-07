#include "FakeDaemon.h"

#include <QFile>
#include <QLocalSocket>

#include "protocol/Handshake.h"

using namespace jarvis::protocol;
using namespace Qt::StringLiterals;

FakeDaemon::FakeDaemon()
    : m_dir(u"/tmp/jsh-XXXXXX"_s)
{
    m_secret = QByteArray(kNonceBytes, '\0');
    for (int i = 0; i < kNonceBytes; ++i)
        m_secret[i] = char(0x5a ^ i);
    QFile secret(secretPath());
    if (secret.open(QIODevice::WriteOnly))
        secret.write(m_secret.toHex() + "\n");
    QObject::connect(&m_server, &QLocalServer::newConnection, this, [this] { onConnection(); });
}

FakeDaemon::~FakeDaemon()
{
    m_server.close();
    for (Peer* peer : std::as_const(m_peers)) {
        peer->socket->disconnect(this);
        peer->socket->abort();
        delete peer->socket;
        delete peer;
    }
    m_peers.clear();
}

bool FakeDaemon::listen()
{
    QLocalServer::removeServer(socketPath());
    m_server.setSocketOptions(QLocalServer::UserAccessOption);
    return m_server.listen(socketPath());
}

QString FakeDaemon::socketPath() const { return m_dir.filePath(u"jarvisd.sock"_s); }
QString FakeDaemon::secretPath() const { return m_dir.filePath(u"control.secret"_s); }

QList<QJsonObject> FakeDaemon::requests(const QString& channel) const
{
    QList<QJsonObject> out;
    for (const QJsonObject& frame : received)
        if (frame.value("t").toString() == u"req" && frame.value("ch").toString() == channel)
            out.append(frame);
    return out;
}

void FakeDaemon::onConnection()
{
    while (QLocalSocket* socket = m_server.nextPendingConnection()) {
        auto* peer = new Peer;
        peer->socket = socket;
        m_peers.append(peer);
        QObject::connect(socket, &QLocalSocket::readyRead, this, [this, peer] { onData(peer); });
        QObject::connect(socket, &QLocalSocket::disconnected, this, [this, peer] { forget(peer); });
    }
}

void FakeDaemon::forget(Peer* peer)
{
    if (!m_peers.removeOne(peer))
        return;
    peer->socket->disconnect(this);
    peer->socket->deleteLater();
    delete peer;
}

void FakeDaemon::sendTo(Peer* peer, const QJsonObject& message)
{
    peer->socket->write(encodeJsonFrame(message));
}

void FakeDaemon::onData(Peer* peer)
{
    peer->decoder.push(peer->socket->readAll());
    while (auto frame = peer->decoder.next()) {
        const QJsonObject m = frame->json;
        received.append(m);
        const QString t = m.value("t").toString();
        if (peer->phase == Peer::Phase::Hello && t == u"hello") {
            ++hellos;
            if (silent)
                continue;
            if (!rawChallenge.isEmpty()) {
                peer->socket->write(rawChallenge);
                continue;
            }
            peer->nonceC = QByteArray::fromHex(m.value("nonceC").toString().toLatin1());
            peer->nonceS = QByteArray(kNonceBytes, '\x11');
            peer->helloBuild = m.value("build").toString();
            QByteArray proof = serverProof(m_secret, peer->nonceC, peer->nonceS);
            if (wrongProof)
                proof[0] = char(proof[0] ^ 1);
            peer->phase = Peer::Phase::Auth;
            sendTo(peer, {{"t", "challenge"},
                          {"nonceS", QString::fromLatin1(peer->nonceS.toHex())},
                          {"proof", QString::fromLatin1(proof.toHex())}});
        } else if (peer->phase == Peer::Phase::Auth && t == u"auth") {
            if (!proofMatches(clientProof(m_secret, peer->nonceS, peer->nonceC), m.value("proof").toString())) {
                peer->socket->abort(); // forget() runs from disconnected; do not touch peer again
                return;
            }
            if (peer->helloBuild != build) {
                sendTo(peer, {{"t", "restart-required"}, {"build", build}});
                peer->socket->disconnectFromServer();
                return;
            }
            peer->phase = Peer::Phase::Open;
            peer->decoder.setMaxBytes(kMaxControlFrameBytes);
            ++welcomes;
            sendTo(peer, {{"t", "welcome"}, {"v", kControlProtocolVersion}, {"capabilities", QJsonArray{}}});
        } else if (peer->phase == Peer::Phase::Open && t == u"req") {
            const quint64 id = quint64(m.value("id").toDouble());
            const Reply reply = handler ? handler(m.value("ch").toString(), m.value("a").toArray(), id) : Reply{};
            if (reply.defer)
                continue;
            if (reply.ok)
                sendTo(peer, {{"t", "res"}, {"id", qint64(id)}, {"v", reply.value}});
            else
                sendTo(peer, {{"t", "err"}, {"id", qint64(id)}, {"code", reply.code}, {"text", reply.text}, {"language", "en"}});
        } else {
            peer->socket->abort();
            return;
        }
    }
}

void FakeDaemon::sendPush(const QString& channel, const QJsonValue& payload)
{
    for (Peer* peer : std::as_const(m_peers))
        if (peer->phase == Peer::Phase::Open)
            sendTo(peer, {{"t", "psh"}, {"ch", channel}, {"p", payload}, {"seq", qint64(++m_seq)}});
}

void FakeDaemon::respond(quint64 id, const QJsonValue& value)
{
    for (Peer* peer : std::as_const(m_peers))
        if (peer->phase == Peer::Phase::Open)
            sendTo(peer, {{"t", "res"}, {"id", qint64(id)}, {"v", value}});
}

void FakeDaemon::dropClients()
{
    const QList<Peer*> peers = m_peers;
    for (Peer* peer : peers)
        peer->socket->abort();
}

int FakeDaemon::openClients() const
{
    int count = 0;
    for (const Peer* peer : m_peers)
        count += peer->phase == Peer::Phase::Open ? 1 : 0;
    return count;
}
