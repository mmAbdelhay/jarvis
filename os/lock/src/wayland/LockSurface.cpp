#include "wayland/LockSurface.h"

#include <QtWaylandClient/private/qwaylandscreen_p.h>
#include <QtWaylandClient/private/qwaylandwindow_p.h>

#include "wayland/SessionLock.h"

LockSurface::LockSurface(SessionLock* lock, QtWaylandClient::QWaylandWindow* window)
    : QtWaylandClient::QWaylandShellSurface(window)
{
    QtWaylandClient::QWaylandScreen* screen = window->waylandScreen();
    ::wl_output* output = screen ? screen->output() : nullptr;
    if (output)
        init(lock->get_lock_surface(window->wlSurface(), output));
}

LockSurface::~LockSurface()
{
    if (object())
        destroy();
}

void LockSurface::applyConfigure()
{
    window()->resizeFromApplyConfigure(m_pending);
}

void LockSurface::ext_session_lock_surface_v1_configure(uint32_t serial, uint32_t width, uint32_t height)
{
    ack_configure(serial);
    m_pending = QSize(int(width), int(height));
    if (!m_configured) {
        m_configured = true;
        window()->resizeFromApplyConfigure(m_pending);
        window()->handleExpose(QRect(QPoint(), m_pending));
    } else {
        window()->applyConfigureWhenPossible();
    }
}
