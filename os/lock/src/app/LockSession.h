#pragma once

#include <QObject>
#include <functional>

class LockBackend;
class LockModel;
class LockReporter;

// One run of jarvis-lock: report "locked" to jarvisd first (approvals stop
// before the screen is even covered), take the compositor lock, unlock only
// after the compositor confirmed it AND the password was right — then report
// "unlocked" (≤ 1.5 s wait) and unlock. Exit codes are read by jarvis-idle.
class LockSession : public QObject {
    Q_OBJECT
public:
    enum Exit { Unlocked = 0, LostLock = 1, Refused = 2, AlreadyRunning = 3 };
    using Say = std::function<void(const QString& line)>;

    LockSession(LockBackend* backend, LockReporter* reporter, LockModel* model, Say say, QObject* parent = nullptr);

    bool start();
    bool isLocked() const { return m_locked; }

signals:
    void exitRequested(int code);

private:
    void onLocked();
    void onFinished();
    void onUnlockRequested();
    void finish(int code);

    LockBackend* m_backend;
    LockReporter* m_reporter;
    LockModel* m_model;
    Say m_say;
    bool m_locked = false;
    bool m_unlockWanted = false;
    bool m_done = false;
};
