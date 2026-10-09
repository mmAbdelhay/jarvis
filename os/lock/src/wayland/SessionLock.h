#pragma once

#include <QObject>

#include "qwayland-ext-session-lock-v1.h"

// ext_session_lock_v1: `locked` once every output is covered, `finished` when
// the compositor refuses or ends the lock.
class SessionLock : public QObject, public QtWayland::ext_session_lock_v1 {
    Q_OBJECT
public:
    explicit SessionLock(struct ::ext_session_lock_v1* object);
    ~SessionLock() override;
    bool isLocked() const { return m_locked; }
    void unlock(); // unlock_and_destroy, only valid after locked()

signals:
    void locked();
    void finished();

protected:
    void ext_session_lock_v1_locked() override;
    void ext_session_lock_v1_finished() override;

private:
    bool m_locked = false;
    bool m_finished = false;
};
