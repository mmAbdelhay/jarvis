#pragma once

#include <QSize>
#include <QtWaylandClient/private/qwaylandshellsurface_p.h>

#include "qwayland-ext-session-lock-v1.h"

class SessionLock;

// One output's ext_session_lock_surface_v1. The compositor chooses the size;
// nothing is exposed (so nothing is drawn) before the first configure.
class LockSurface : public QtWaylandClient::QWaylandShellSurface, public QtWayland::ext_session_lock_surface_v1 {
public:
    LockSurface(SessionLock* lock, QtWaylandClient::QWaylandWindow* window);
    ~LockSurface() override;

    bool isExposed() const override { return m_configured; }
    void applyConfigure() override;

protected:
    void ext_session_lock_surface_v1_configure(uint32_t serial, uint32_t width, uint32_t height) override;

private:
    QSize m_pending;
    bool m_configured = false;
};
