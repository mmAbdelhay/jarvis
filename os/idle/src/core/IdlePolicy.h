#pragma once

#include <QList>
#include <QObject>
#include <functional>

// When to run jarvis-lock (Rafiq M3 contracts §3): after idle time, on lid
// close, before sleep and when logind asks (Super+L → loginctl lock-session).
// One locker at a time. A locker that crashed or lost its lock (killed, or
// exit 1) is started again — the compositor keeps the screen blank meanwhile —
// at most kMaxRestarts times a minute. A refused lock (2), a second instance
// (3) or a missing program is not retried.
class IdlePolicy : public QObject {
    Q_OBJECT
public:
    static constexpr int kMaxRestarts = 5;
    static constexpr qint64 kRestartWindowMs = 60'000;

    explicit IdlePolicy(std::function<qint64()> now = {}, QObject* parent = nullptr);

    bool isRunning() const { return m_running; }
    bool isConfirmed() const { return m_confirmed; }

public slots:
    void onIdle() { requestLock(); }
    void onLidClosed() { requestLock(); }
    void onLockRequested() { requestLock(); }
    void onSleepComing();
    void onLockConfirmed();
    void onLockExited(int exitCode, bool crashed);

signals:
    void launchLock();
    void releaseSleepDelay();
    void gaveUp(const QString& reason);

private:
    void requestLock();
    void launch();
    void releaseSleepIfPending();

    std::function<qint64()> m_now;
    bool m_running = false;
    bool m_confirmed = false;
    bool m_sleepPending = false;
    QList<qint64> m_restarts;
};
