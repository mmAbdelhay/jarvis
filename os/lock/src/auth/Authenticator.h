#pragma once

#include <QByteArray>
#include <QObject>

// Checks one password. Exactly one finished() follows each start(); the
// implementation wipes its copy of the secret when done (auth/Wipe.h).
class Authenticator : public QObject {
    Q_OBJECT
public:
    using QObject::QObject;
    virtual void start(const QString& user, QByteArray secret) = 0;

signals:
    void finished(bool ok, const QString& message);
};
