#pragma once

#include <QObject>
#include <functional>

class ControlClient;

// Tells jarvisd whether the session is locked (Rafiq M3 contracts §3:
// sys:setLocked [{locked}], accepted only from /usr/bin/jarvis-lock; while
// locked jarvisd refuses agent:confirm from every client). The last state is
// re-sent after every reconnect, so a jarvisd that starts or restarts during
// a lock still learns it. Unlocking never waits on jarvisd for long.
class LockReporter : public QObject {
    Q_OBJECT
public:
    static constexpr int kUnlockReportTimeoutMs = 1500;

    explicit LockReporter(ControlClient* client, QObject* parent = nullptr);

    void setLocked(bool locked);
    void reportUnlocked(std::function<void()> then, int timeoutMs = kUnlockReportTimeoutMs);
    bool locked() const { return m_locked; }

private:
    void send(std::function<void()> done = {});

    ControlClient* m_client;
    bool m_locked = false;
    bool m_known = false;
};
