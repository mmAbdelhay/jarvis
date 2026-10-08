#pragma once

#include <QObject>

struct wl_display;
struct wl_registry;
struct wl_seat;
struct ext_idle_notifier_v1;
struct ext_idle_notification_v1;
class QSocketNotifier;

// ext-idle-notify-v1 on the session's compositor through plain
// libwayland-client: idled() after `timeout` without input, resumed() on the
// next input. Uses get_idle_notification, so an idle inhibitor (a playing
// video) keeps the session from locking.
class IdleNotifier : public QObject {
    Q_OBJECT
public:
    explicit IdleNotifier(QObject* parent = nullptr);
    ~IdleNotifier() override;

    bool connectToCompositor();
    void setTimeoutMs(quint32 ms);
    QString error() const { return m_error; }

signals:
    void idled();
    void resumed();
    void compositorGone();

private:
    static void registryGlobal(void* data, wl_registry* registry, uint32_t name, const char* interface, uint32_t version);
    static void registryGlobalRemove(void* data, wl_registry* registry, uint32_t name);
    static void notificationIdled(void* data, ext_idle_notification_v1* notification);
    static void notificationResumed(void* data, ext_idle_notification_v1* notification);
    void dispatch();

    wl_display* m_display = nullptr;
    wl_registry* m_registry = nullptr;
    wl_seat* m_seat = nullptr;
    ext_idle_notifier_v1* m_notifier = nullptr;
    ext_idle_notification_v1* m_notification = nullptr;
    QSocketNotifier* m_socket = nullptr;
    QString m_error;
};
