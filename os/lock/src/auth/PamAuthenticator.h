#pragma once

#include <QPointer>
#include <QThread>

#include "auth/Authenticator.h"

// The user's own password through PAM service "jarvis-lock"
// (/etc/pam.d/jarvis-lock, Rafiq M3 contracts §3), off the GUI thread:
// pam_authenticate, pam_acct_mgmt (an expired password still unlocks — it
// cannot be changed here), PAM_REFRESH_CRED. One password per attempt; a
// module asking for anything else fails the attempt.
class PamAuthenticator : public Authenticator {
    Q_OBJECT
public:
    explicit PamAuthenticator(QByteArray service = QByteArrayLiteral("jarvis-lock"), QObject* parent = nullptr);
    ~PamAuthenticator() override;

    void start(const QString& user, QByteArray secret) override;

private:
    QByteArray m_service;
    QPointer<QThread> m_worker;
};
