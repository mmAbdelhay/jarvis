#pragma once

#include <QHash>
#include <functional>

#include "app/LockBackend.h"

class QQuickWindow;
class QScreen;
class SessionLock;
class SessionLockIntegration;

// Covers every output (and any output plugged in later) with a lock surface.
class WaylandLockBackend : public LockBackend {
    Q_OBJECT
public:
    using WindowFactory = std::function<QQuickWindow*(QScreen* screen, bool primary)>;
    explicit WaylandLockBackend(WindowFactory factory, QObject* parent = nullptr);
    ~WaylandLockBackend() override;

    bool lock() override;
    void unlock() override;

private:
    void cover(QScreen* screen);

    WindowFactory m_factory;
    SessionLockIntegration* m_integration = nullptr;
    SessionLock* m_lock = nullptr;
    QHash<QScreen*, QQuickWindow*> m_windows;
};
