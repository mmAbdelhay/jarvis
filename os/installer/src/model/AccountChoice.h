#pragma once

#include <QJsonObject>
#include <QObject>
#include <QtQml/qqmlregistration.h>

// Account step (design: "Your account"). Username and computer name are
// derived until edited. Passwords stay here (and in their fields) until
// InstallerModel builds Execute's secretsJson, then wipe() clears them.
class AccountChoice : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by InstallerModel")
    Q_PROPERTY(QString fullName READ fullName WRITE setFullName NOTIFY changed)
    Q_PROPERTY(QString username READ username WRITE setUsername NOTIFY changed)
    Q_PROPERTY(QString hostname READ hostname WRITE setHostname NOTIFY changed)
    Q_PROPERTY(QString password READ password WRITE setPassword NOTIFY changed)
    Q_PROPERTY(QString confirm READ confirm WRITE setConfirm NOTIFY changed)
    Q_PROPERTY(bool autologin READ autologin WRITE setAutologin NOTIFY changed)
    Q_PROPERTY(bool encrypt READ encrypt NOTIFY changed)
    Q_PROPERTY(bool diskSameAsPassword READ diskSameAsPassword WRITE setDiskSameAsPassword NOTIFY changed)
    Q_PROPERTY(QString diskPassphrase READ diskPassphrase WRITE setDiskPassphrase NOTIFY changed)
    Q_PROPERTY(QString diskConfirm READ diskConfirm WRITE setDiskConfirm NOTIFY changed)
    Q_PROPERTY(QString usernameProblem READ usernameProblem NOTIFY changed)
    Q_PROPERTY(QString hostnameProblem READ hostnameProblem NOTIFY changed)
    Q_PROPERTY(QString passwordStatus READ passwordStatus NOTIFY changed)
    Q_PROPERTY(bool passwordOk READ passwordOk NOTIFY changed)
    Q_PROPERTY(QString diskStatus READ diskStatus NOTIFY changed)
    Q_PROPERTY(bool diskOk READ diskOk NOTIFY changed)
    Q_PROPERTY(bool valid READ valid NOTIFY changed)
    Q_PROPERTY(QString blockText READ blockText NOTIFY changed)

public:
    explicit AccountChoice(QObject* parent = nullptr);
    ~AccountChoice() override;

    QString fullName() const { return m_fullName; }
    QString username() const { return m_username; }
    QString hostname() const { return m_hostname; }
    QString password() const { return m_password; }
    QString confirm() const { return m_confirm; }
    bool autologin() const { return m_autologin; }
    bool encrypt() const { return m_encrypt; }
    bool diskSameAsPassword() const { return m_diskSame; }
    QString diskPassphrase() const { return m_diskPassphrase; }
    QString diskConfirm() const { return m_diskConfirm; }
    void setFullName(const QString& name);
    void setUsername(const QString& name);
    void setHostname(const QString& name);
    void setPassword(const QString& value);
    void setConfirm(const QString& value);
    void setAutologin(bool on);
    void setEncrypt(bool on);
    void setDiskSameAsPassword(bool same);
    void setDiskPassphrase(const QString& value);
    void setDiskConfirm(const QString& value);

    QString usernameProblem() const;
    QString hostnameProblem() const;
    QString passwordStatus() const;
    bool passwordOk() const;
    QString diskStatus() const;
    bool diskOk() const;
    bool valid() const { return blockText().isEmpty(); }
    QString blockText() const;

    QJsonObject toJson() const;      // Choices.user — never a secret
    QByteArray secretsJson() const;  // Execute's secretsJson (contracts §1)
    void wipe();

signals:
    void changed();

private:
    void setString(QString& field, const QString& value);

    QString m_fullName, m_username, m_hostname;
    QString m_password, m_confirm, m_diskPassphrase, m_diskConfirm;
    bool m_usernameEdited = false;
    bool m_hostnameEdited = false;
    bool m_autologin = false;
    bool m_encrypt = true;
    bool m_diskSame = true;
};
