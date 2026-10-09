#pragma once

#include <QObject>
#include <QString>

// Power off / restart the machine. LogindPower is the real one (M2 contracts
// §8: org.freedesktop.login1.Manager.PowerOff/Reboot, interactive=false).
class PowerActions : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    virtual bool available() const = 0;
    virtual void powerOff() = 0;
    virtual void reboot() = 0;

signals:
    void failed(const QString& message);
};
