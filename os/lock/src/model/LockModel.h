#pragma once

#include <QObject>
#include <QTimer>
#include <QtQml/qqmlregistration.h>

#include "auth/Authenticator.h"
#include "model/CurrentUser.h"

// The unlock conversation: one password at a time, a growing pause after
// three failures (on top of PAM's own delay and faillock), and
// unlockRequested() once — LockSession then reports and unlocks. The model
// keeps no copy of any password.
class LockModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by main()")
    Q_PROPERTY(QString displayName READ displayName CONSTANT)
    Q_PROPERTY(QString initial READ initial CONSTANT)
    Q_PROPERTY(QString state READ state NOTIFY stateChanged)
    Q_PROPERTY(QString errorText READ errorText NOTIFY stateChanged)
    Q_PROPERTY(int cooldownSeconds READ cooldownSeconds NOTIFY stateChanged)
    Q_PROPERTY(int failures READ failures NOTIFY stateChanged)

public:
    LockModel(Authenticator* authenticator, CurrentUser user, QObject* parent = nullptr);

    QString displayName() const { return m_user.displayName; }
    QString initial() const { return m_user.initial(); }
    QString state() const { return m_state; }
    QString errorText() const { return m_errorText; }
    int cooldownSeconds() const { return m_cooldown; }
    int failures() const { return m_failures; }

    Q_INVOKABLE void submit(const QString& secret);
    Q_INVOKABLE void tick(); // one second of cooldown (the timer calls it)
    static int cooldownFor(int failures);

signals:
    void stateChanged();
    void unlockRequested();

private:
    void onFinished(bool ok, const QString& message);
    void setState(const QString& state);

    Authenticator* m_authenticator;
    CurrentUser m_user;
    QString m_state = QStringLiteral("ready");
    QString m_errorText;
    int m_failures = 0;
    int m_cooldown = 0;
    QTimer m_timer;
};
