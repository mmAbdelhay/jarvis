#pragma once

#include <QtWaylandClient/private/qwaylandshellintegration_p.h>

#include "qwayland-ext-session-lock-v1.h"

class SessionLock;

// ext_session_lock_manager_v1 as a QtWaylandClient shell integration — the
// technique layer-shell-qt uses for wlr-layer-shell. A window given this
// integration (QWaylandWindow::setShellIntegration, before show) becomes a
// lock surface of the one SessionLock.
class SessionLockIntegration
    : public QtWaylandClient::QWaylandShellIntegrationTemplate<SessionLockIntegration>
    , public QtWayland::ext_session_lock_manager_v1 {
public:
    SessionLockIntegration();
    ~SessionLockIntegration() override;

    SessionLock* startLock(); // null when the compositor has no ext_session_lock_manager_v1
    QtWaylandClient::QWaylandShellSurface* createShellSurface(QtWaylandClient::QWaylandWindow* window) override;

private:
    SessionLock* m_lock = nullptr;
};
