#pragma once

#include <QDBusConnection>
#include <QDBusVirtualObject>
#include <atomic>
#include <memory>

class QThread;

// org.freedesktop.login1 on a private session bus: GetSessionByPID,
// GetSession, Inhibit (a pipe whose read end shows whether the delay lock is
// still held), Properties.Get LidClosed, and the Lock / PrepareForSleep signals.
class FakeLogind : public QDBusVirtualObject {
public:
    static constexpr const char* kSessionPath = "/org/freedesktop/login1/session/_31";
    // Serves from its own thread with its own event loop: the watcher under test
    // makes blocking D-Bus calls from the main thread, which would deadlock a
    // same-thread service.
    FakeLogind();
    ~FakeLogind() override;

    bool start();
    void emitLock();
    void emitPrepareForSleep(bool start);
    bool delayHeld() const;

    std::atomic<bool> lidClosed{false};
    std::atomic<int> inhibitCalls{0};

    QString introspect(const QString&) const override { return {}; }
    bool handleMessage(const QDBusMessage& message, const QDBusConnection& connection) override;

private:
    QDBusConnection m_bus{QStringLiteral("fake-logind")}; // assigned by the serving thread
    std::atomic<int> m_readEnd{-1};
    QThread* m_thread = nullptr;
};
