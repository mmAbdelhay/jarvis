#include "linux/IdleNotifier.h"

#include <QAbstractEventDispatcher>
#include <QSocketNotifier>
#include <cstring>
#include <wayland-client.h>

#include "ext-idle-notify-v1-client-protocol.h"

using namespace Qt::StringLiterals;

IdleNotifier::IdleNotifier(QObject* parent)
    : QObject(parent)
{
}

IdleNotifier::~IdleNotifier()
{
    if (m_notification)
        ext_idle_notification_v1_destroy(m_notification);
    if (m_notifier)
        ext_idle_notifier_v1_destroy(m_notifier);
    if (m_seat)
        wl_seat_destroy(m_seat);
    if (m_registry)
        wl_registry_destroy(m_registry);
    if (m_display)
        wl_display_disconnect(m_display);
}

void IdleNotifier::registryGlobal(void* data, wl_registry* registry, uint32_t name, const char* interface, uint32_t)
{
    auto* self = static_cast<IdleNotifier*>(data);
    if (std::strcmp(interface, ext_idle_notifier_v1_interface.name) == 0 && !self->m_notifier)
        self->m_notifier = static_cast<ext_idle_notifier_v1*>(wl_registry_bind(registry, name, &ext_idle_notifier_v1_interface, 1));
    else if (std::strcmp(interface, wl_seat_interface.name) == 0 && !self->m_seat)
        self->m_seat = static_cast<wl_seat*>(wl_registry_bind(registry, name, &wl_seat_interface, 1));
}

void IdleNotifier::registryGlobalRemove(void*, wl_registry*, uint32_t) {}

void IdleNotifier::notificationIdled(void* data, ext_idle_notification_v1*)
{
    emit static_cast<IdleNotifier*>(data)->idled();
}

void IdleNotifier::notificationResumed(void* data, ext_idle_notification_v1*)
{
    emit static_cast<IdleNotifier*>(data)->resumed();
}

bool IdleNotifier::connectToCompositor()
{
    static const wl_registry_listener registryListener{&IdleNotifier::registryGlobal, &IdleNotifier::registryGlobalRemove};
    m_display = wl_display_connect(nullptr);
    if (!m_display) {
        m_error = u"No Wayland display (WAYLAND_DISPLAY is unset or the compositor is gone)."_s;
        return false;
    }
    m_registry = wl_display_get_registry(m_display);
    wl_registry_add_listener(m_registry, &registryListener, this);
    wl_display_roundtrip(m_display);
    if (!m_notifier) {
        m_error = u"The compositor does not offer ext-idle-notify-v1."_s;
        return false;
    }
    if (!m_seat) {
        m_error = u"The compositor has no seat."_s;
        return false;
    }
    m_socket = new QSocketNotifier(wl_display_get_fd(m_display), QSocketNotifier::Read, this);
    connect(m_socket, &QSocketNotifier::activated, this, &IdleNotifier::dispatch);
    connect(QAbstractEventDispatcher::instance(), &QAbstractEventDispatcher::aboutToBlock, this, [this] {
        if (m_display) {
            wl_display_dispatch_pending(m_display);
            wl_display_flush(m_display);
        }
    });
    return true;
}

void IdleNotifier::setTimeoutMs(quint32 ms)
{
    static const ext_idle_notification_v1_listener listener{&IdleNotifier::notificationIdled, &IdleNotifier::notificationResumed};
    if (m_notification) {
        ext_idle_notification_v1_destroy(m_notification);
        m_notification = nullptr;
    }
    if (!m_notifier || !m_seat || ms == 0)
        return;
    m_notification = ext_idle_notifier_v1_get_idle_notification(m_notifier, ms, m_seat);
    ext_idle_notification_v1_add_listener(m_notification, &listener, this);
    wl_display_flush(m_display);
}

void IdleNotifier::dispatch()
{
    if (wl_display_dispatch(m_display) < 0) {
        m_socket->setEnabled(false);
        emit compositorGone();
    }
}
