#pragma once

#include <QDBusConnection>
#include <QDBusUnixFileDescriptor>
#include <QObject>
#include <QTimer>

// logind for jarvis-idle: Session.Lock (loginctl lock-session, Super+L),
// PrepareForSleep (lock before suspend, holding a "delay" sleep inhibitor
// until the locker covers the screen), and LidClosed (polled: a docked lid
// close that does not suspend still locks).
class LogindWatcher : public QObject {
    Q_OBJECT
public:
    explicit LogindWatcher(QDBusConnection bus = QDBusConnection::systemBus(), QObject* parent = nullptr);

    bool start();
    void takeSleepDelay();
    void releaseSleepDelay();
    bool holdsSleepDelay() const { return m_delay.isValid(); }
    void setLidPollIntervalForTest(int ms) { m_lidPoll.setInterval(ms); }

signals:
    void lockRequested();
    void lidClosed();
    void sleepComing();
    void resumed();

private slots:
    void onLock();
    void onPrepareForSleep(bool start);

private:
    bool lidClosedNow();

    QDBusConnection m_bus;
    QString m_sessionPath;
    QDBusUnixFileDescriptor m_delay;
    QTimer m_lidPoll;
    bool m_lidWasClosed = false;
};
