#include "wayland/SessionLock.h"

SessionLock::SessionLock(struct ::ext_session_lock_v1* object)
    : QtWayland::ext_session_lock_v1(object)
{
}

SessionLock::~SessionLock()
{
    // `destroy` is a protocol error once `locked` was sent: a locker that
    // exits without unlocking leaves the session locked (the safe failure).
    if (object() && !m_locked && !m_finished)
        destroy();
}

void SessionLock::unlock()
{
    if (object() && m_locked)
        unlock_and_destroy();
}

void SessionLock::ext_session_lock_v1_locked()
{
    m_locked = true;
    emit locked();
}

void SessionLock::ext_session_lock_v1_finished()
{
    m_finished = true;
    emit finished();
}
