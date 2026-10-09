#pragma once

#include <QJsonObject>
#include <QObject>
#include <QTimer>
#include <QtQml/qqmlregistration.h>

// A phone asking to pair (Rafiq M3 contracts §5.9: pairing:pending
// {requestId, deviceName, address, expiresAt} → pairing:answer
// [{requestId, approve}]). Name and address come from the phone, so they are
// untrusted: cleaned to one plain line. A malformed requestId shows no card.
// Approving is impossible while the screen is locked; no answer within 60 s
// sends nothing (jarvisd's own window expires as a refusal).
class PairingModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by ShellController")
    Q_PROPERTY(bool active READ active NOTIFY changed)
    Q_PROPERTY(QString deviceName READ deviceName NOTIFY changed)
    Q_PROPERTY(QString address READ address NOTIFY changed)
    Q_PROPERTY(bool locked READ locked NOTIFY changed)
    Q_PROPERTY(int secondsLeft READ secondsLeft NOTIFY changed)

public:
    static constexpr int kSeconds = 60; // packages/remote CONFIRMATION_TTL_MS
    static constexpr int kMaxNameLength = 64;

    explicit PairingModel(QObject* parent = nullptr);

    bool active() const { return !m_requestId.isEmpty(); }
    QString deviceName() const { return m_name; }
    QString address() const { return m_address; }
    QString requestId() const { return m_requestId; }
    bool locked() const { return m_locked; }
    int secondsLeft() const { return m_secondsLeft; }

    Q_INVOKABLE bool load(const QJsonObject& pending);
    Q_INVOKABLE void approve();
    Q_INVOKABLE void deny();
    Q_INVOKABLE void tick();
    void setLocked(bool locked);
    void close();

    static QString cleanName(const QString& name);
    static bool validRequestId(const QString& id);

signals:
    void changed();
    void answered(const QString& requestId, bool approve);

private:
    QString m_name;
    QString m_address;
    QString m_requestId;
    bool m_locked = false;
    int m_secondsLeft = 0;
    QTimer m_timer;
};
