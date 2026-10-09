#pragma once

#include "auth/Authenticator.h"

// Records what it was asked and answers when the test says so.
class FakeAuthenticator : public Authenticator {
    Q_OBJECT
public:
    using Authenticator::Authenticator;
    void start(const QString& user, QByteArray secret) override
    {
        lastUser = user;
        lastSecret = QString::fromUtf8(secret);
        ++calls;
    }
    Q_INVOKABLE void resolve(bool ok, const QString& message = {}) { emit finished(ok, message); }
    Q_INVOKABLE QString secretSeen() const { return lastSecret; }

    QString lastUser;
    QString lastSecret;
    int calls = 0;
};
