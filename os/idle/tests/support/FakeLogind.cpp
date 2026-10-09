#include "FakeLogind.h"

#include <QDBusMessage>
#include <QSemaphore>
#include <QThread>
#include <QDBusObjectPath>
#include <QDBusUnixFileDescriptor>
#include <QDBusVariant>
#include <poll.h>
#include <unistd.h>

using namespace Qt::StringLiterals;

namespace {
class ServeThread : public QThread {
public:
    explicit ServeThread(FakeLogind* owner, QDBusConnection& bus)
        : m_owner(owner), m_bus(bus) {}
    bool ok = false;
    QSemaphore ready;

protected:
    void run() override
    {
        m_bus = QDBusConnection::connectToBus(QDBusConnection::SessionBus, u"fake-logind"_s);
        ok = m_bus.registerVirtualObject(u"/org/freedesktop/login1"_s, m_owner, QDBusConnection::SubPath)
            && m_bus.registerService(u"org.freedesktop.login1"_s);
        ready.release();
        if (ok)
            exec();
        m_bus.unregisterObject(u"/org/freedesktop/login1"_s);
    }

private:
    FakeLogind* m_owner;
    QDBusConnection& m_bus;
};
} // namespace

FakeLogind::FakeLogind() = default;

FakeLogind::~FakeLogind()
{
    if (m_thread) {
        m_thread->quit();
        m_thread->wait();
        delete m_thread;
    }
    if (m_readEnd >= 0)
        ::close(m_readEnd);
}

bool FakeLogind::start()
{
    auto* thread = new ServeThread(this, m_bus);
    m_thread = thread;
    moveToThread(thread); // handleMessage must run on the serving thread, not the test thread
    thread->start();
    thread->ready.acquire();
    return thread->ok;
}

bool FakeLogind::handleMessage(const QDBusMessage& message, const QDBusConnection& connection)
{
    const QString member = message.member();
    if (member == u"GetSessionByPID" || member == u"GetSession") {
        connection.send(message.createReply(QVariant::fromValue(QDBusObjectPath(QString::fromLatin1(kSessionPath)))));
        return true;
    }
    if (member == u"Inhibit") {
        int fds[2];
        if (::pipe(fds) != 0)
            return false;
        const int old = m_readEnd.exchange(fds[0]);
        if (old >= 0)
            ::close(old);
        ++inhibitCalls;
        connection.send(message.createReply(QVariant::fromValue(QDBusUnixFileDescriptor(fds[1]))));
        ::close(fds[1]); // QDBusUnixFileDescriptor dup'ed it
        return true;
    }
    if (member == u"Get" && message.arguments().value(1).toString() == u"LidClosed") {
        connection.send(message.createReply(QVariant::fromValue(QDBusVariant(lidClosed.load()))));
        return true;
    }
    return false;
}

void FakeLogind::emitLock()
{
    m_bus.send(QDBusMessage::createSignal(QString::fromLatin1(kSessionPath), u"org.freedesktop.login1.Session"_s, u"Lock"_s));
}

void FakeLogind::emitPrepareForSleep(bool start)
{
    QDBusMessage signal = QDBusMessage::createSignal(u"/org/freedesktop/login1"_s, u"org.freedesktop.login1.Manager"_s,
                                                     u"PrepareForSleep"_s);
    signal << start;
    m_bus.send(signal);
}

bool FakeLogind::delayHeld() const
{
    const int fd = m_readEnd;
    if (fd < 0)
        return false;
    pollfd p{fd, POLLIN, 0};
    ::poll(&p, 1, 0);
    return !(p.revents & (POLLHUP | POLLIN)); // EOF once every write end is closed
}
