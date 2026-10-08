#include "wayland/WaylandLockBackend.h"

#include <QGuiApplication>
#include <QQuickWindow>
#include <QScreen>
#include <QtGui/private/qguiapplication_p.h>
#include <QtWaylandClient/private/qwaylanddisplay_p.h>
#include <QtWaylandClient/private/qwaylandintegration_p.h>
#include <QtWaylandClient/private/qwaylandwindow_p.h>

#include "wayland/SessionLock.h"
#include "wayland/SessionLockIntegration.h"

namespace {
QtWaylandClient::QWaylandDisplay* waylandDisplay()
{
    auto* integration = dynamic_cast<QtWaylandClient::QWaylandIntegration*>(QGuiApplicationPrivate::platformIntegration());
    return integration ? integration->display() : nullptr;
}
} // namespace

WaylandLockBackend::WaylandLockBackend(WindowFactory factory, QObject* parent)
    : LockBackend(parent)
    , m_factory(std::move(factory))
{
}

WaylandLockBackend::~WaylandLockBackend()
{
    qDeleteAll(m_windows);
    delete m_integration;
}

bool WaylandLockBackend::lock()
{
    QtWaylandClient::QWaylandDisplay* display = waylandDisplay();
    if (!display)
        return false;
    m_integration = new SessionLockIntegration();
    if (!m_integration->initialize(display))
        return false; // no ext_session_lock_manager_v1
    m_lock = m_integration->startLock();
    if (!m_lock)
        return false;
    connect(m_lock, &SessionLock::locked, this, &LockBackend::locked);
    connect(m_lock, &SessionLock::finished, this, &LockBackend::finished);
    const QList<QScreen*> screens = QGuiApplication::screens();
    for (QScreen* screen : screens)
        cover(screen);
    connect(qGuiApp, &QGuiApplication::screenAdded, this, &WaylandLockBackend::cover);
    connect(qGuiApp, &QGuiApplication::screenRemoved, this, [this](QScreen* screen) {
        if (QQuickWindow* window = m_windows.take(screen))
            window->deleteLater();
    });
    return true;
}

void WaylandLockBackend::cover(QScreen* screen)
{
    if (!m_lock || m_windows.contains(screen))
        return;
    QQuickWindow* window = m_factory(screen, screen == QGuiApplication::primaryScreen());
    window->setScreen(screen);
    window->create();
    auto* waylandWindow = dynamic_cast<QtWaylandClient::QWaylandWindow*>(window->handle());
    if (!waylandWindow) {
        delete window;
        return;
    }
    waylandWindow->setShellIntegration(m_integration); // before show(): this window is a lock surface
    window->show();
    m_windows.insert(screen, window);
}

void WaylandLockBackend::unlock()
{
    if (!m_lock)
        return;
    m_lock->unlock();
    if (QtWaylandClient::QWaylandDisplay* display = waylandDisplay())
        wl_display_roundtrip(display->wl_display());
}
