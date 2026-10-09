#include "wayland/LockSurface.h"

#include <QtWaylandClient/private/qwaylandscreen_p.h>
#include <QtWaylandClient/private/qwaylandwindow_p.h>

#include "wayland/SessionLock.h"

LockSurface::LockSurface(SessionLock* lock, QtWaylandClient::QWaylandWindow* window)
    : QtWaylandClient::QWaylandShellSurface(window)
{
    // Qt 6.8's QWaylandWindow::initWindow commits the wl_surface right after
    // creating the shell surface (xdg-shell needs that empty commit). On a
    // lock surface a commit before the first configure is a protocol error
    // (labwc: "committed with a null buffer"), so the role is assigned once
    // initWindow has returned: the empty commit lands on a role-less surface.
    QMetaObject::invokeMethod(
        this,
        [this, lock, window] {
            QtWaylandClient::QWaylandScreen* screen = window->waylandScreen();
            ::wl_output* output = screen ? screen->output() : nullptr;
            if (output && window->wlSurface())
                init(lock->get_lock_surface(window->wlSurface(), output));
        },
        Qt::QueuedConnection);
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
        // Qt 6.8 (trixie) has no QWaylandWindow::handleExpose; isExposed() now
        // returns true, so a recursive expose delivers the first frame.
        window()->sendRecursiveExposeEvent();
    } else {
        window()->applyConfigureWhenPossible();
    }
}
