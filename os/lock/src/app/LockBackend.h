#pragma once

#include <QObject>

// The compositor side of a lock: ext-session-lock-v1 on Linux
// (WaylandLockBackend), a fake in tests.
class LockBackend : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    virtual bool lock() = 0;   // ask for the lock; false: this compositor cannot lock
    virtual void unlock() = 0; // only after locked(): unlock_and_destroy + roundtrip

signals:
    void locked();   // every output is covered by our surfaces
    void finished(); // the compositor refused, or ended, the lock
};
