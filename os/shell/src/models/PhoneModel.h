#pragma once

#include <QJsonObject>
#include <QObject>
#include <QVariantList>
#include <QtQml/qqmlregistration.h>

// Settings → Phone (Rafiq M3 contracts §5.9): turn the Jarvis phone bridge on
// or off, set the owner password, open a pairing window and revoke paired
// phones. State comes from remote:status (reply and push). Device names come
// from phones, so they are cleaned to one plain line. Passwords are never
// kept: they go straight into the request and nowhere else.
class PhoneModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY changed)
    Q_PROPERTY(bool enabled READ enabled NOTIFY changed)
    Q_PROPERTY(QString address READ address NOTIFY changed)
    Q_PROPERTY(QString fingerprint READ fingerprint NOTIFY changed)
    Q_PROPERTY(QString pairing READ pairing NOTIFY changed)
    Q_PROPERTY(QString pairingUri READ pairingUri NOTIFY changed)
    Q_PROPERTY(bool hasOwnerPassword READ hasOwnerPassword NOTIFY changed)
    Q_PROPERTY(QString problem READ problem NOTIFY changed)
    Q_PROPERTY(QVariantList devices READ devices NOTIFY changed)
    Q_PROPERTY(QString error READ error NOTIFY changed)
    Q_PROPERTY(QString note READ note NOTIFY changed)

public:
    explicit PhoneModel(QObject* parent = nullptr);

    bool known() const { return m_known; }
    bool enabled() const { return m_enabled; }
    QString address() const { return m_address; }
    QString fingerprint() const { return m_fingerprint; }
    QString pairing() const { return m_pairing; }
    QString pairingUri() const { return m_pairingUri; }
    bool hasOwnerPassword() const { return m_hasOwnerPassword; }
    QString problem() const { return m_problem; }
    QVariantList devices() const { return m_devices; }
    QString error() const { return m_error; }
    QString note() const { return m_note; }

    Q_INVOKABLE void refresh();
    Q_INVOKABLE void setEnabled(bool enabled);
    Q_INVOKABLE void setOwnerPassword(const QString& current, const QString& next);
    Q_INVOKABLE void openPairing();
    Q_INVOKABLE void cancelPairing();
    Q_INVOKABLE void revoke(const QString& deviceId);

    Q_INVOKABLE void applyStatus(const QJsonObject& status);
    Q_INVOKABLE void applyPairingOpened(const QJsonObject& opened);
    Q_INVOKABLE void applyOwnerPasswordResult(const QJsonObject& result);
    Q_INVOKABLE void applyError(const QString& text);

signals:
    void changed();
    void statusRequested();
    void configureRequested(bool enabled);
    void ownerPasswordRequested(const QString& current, const QString& next);
    void pairingOpenRequested();
    void pairingCancelRequested();
    void revokeRequested(const QString& deviceId);

private:
    void clearMessages();

    bool m_known = false;
    bool m_enabled = false;
    QString m_address;
    QString m_fingerprint;
    QString m_pairing = QStringLiteral("closed");
    QString m_pairingUri;
    bool m_hasOwnerPassword = false;
    QString m_problem;
    QVariantList m_devices;
    QString m_error;
    QString m_note;
};
