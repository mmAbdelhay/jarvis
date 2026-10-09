#include "wayland/SessionLockIntegration.h"

#include "wayland/LockSurface.h"
#include "wayland/SessionLock.h"

SessionLockIntegration::SessionLockIntegration()
    : QtWaylandClient::QWaylandShellIntegrationTemplate<SessionLockIntegration>(1)
{
}

SessionLockIntegration::~SessionLockIntegration()
{
    delete m_lock;
    if (object())
        destroy();
}

SessionLock* SessionLockIntegration::startLock()
{
    if (!m_lock && isActive())
        m_lock = new SessionLock(lock());
    return m_lock;
}

QtWaylandClient::QWaylandShellSurface* SessionLockIntegration::createShellSurface(QtWaylandClient::QWaylandWindow* window)
{
    return m_lock ? new LockSurface(m_lock, window) : nullptr;
}
