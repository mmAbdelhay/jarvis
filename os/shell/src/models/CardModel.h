#pragma once

#include <QAbstractListModel>
#include <QHash>
#include <QJsonObject>
#include <QTimer>
#include <QtQml/qqmlregistration.h>
#include <functional>

// One confirm card (contracts §3.3 Card): its items with tick state, the
// values typed into secret fields, and the countdown to expiresAt. It builds
// the `agent:confirm` argument; it never sends anything itself.
class CardModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool active READ active NOTIFY changed)
    Q_PROPERTY(QString cardId READ cardId NOTIFY changed)
    Q_PROPERTY(QString turnId READ turnId NOTIFY changed)
    Q_PROPERTY(bool exclusive READ exclusive NOTIFY changed)
    Q_PROPERTY(int itemCount READ itemCount NOTIFY changed)
    Q_PROPERTY(int tickedCount READ tickedCount NOTIFY changed)
    Q_PROPERTY(QString headline READ headline NOTIFY changed)
    Q_PROPERTY(QString approveLabel READ approveLabel NOTIFY changed)
    Q_PROPERTY(bool canApprove READ canApprove NOTIFY changed)
    Q_PROPERTY(int secondsLeft READ secondsLeft NOTIFY changed)
    Q_PROPERTY(bool expired READ expired NOTIFY changed)
    Q_PROPERTY(QString countdownText READ countdownText NOTIFY changed)

public:
    enum Role {
        ItemIdRole = Qt::UserRole + 1, ToolRole, TitleRole, DetailRole, SourceRole,
        SourceLabelRole, RiskRole, TickedRole, SecretFieldsRole
    };
    Q_ENUM(Role)

    explicit CardModel(QObject* parent = nullptr);
    ~CardModel() override;

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    bool active() const { return !m_cardId.isEmpty(); }
    QString cardId() const { return m_cardId; }
    QString turnId() const { return m_turnId; }
    bool exclusive() const { return m_exclusive; }
    int itemCount() const { return int(m_items.size()); }
    int tickedCount() const;
    QString headline() const;
    QString approveLabel() const;
    bool canApprove() const;
    int secondsLeft() const { return m_secondsLeft; }
    bool expired() const { return active() && m_secondsLeft == 0; }
    QString countdownText() const;

    Q_INVOKABLE bool load(const QJsonObject& card);
    Q_INVOKABLE void setTicked(int row, bool ticked);
    Q_INVOKABLE void toggle(int row);
    Q_INVOKABLE void setSecret(int row, const QString& field, const QString& value);
    Q_INVOKABLE QJsonObject decision(bool approve) const;
    Q_INVOKABLE void close();
    Q_INVOKABLE void tick();
    Q_INVOKABLE void setClockForTest(double nowMs);

signals:
    void changed();

private:
    struct Item {
        QString itemId, tool, title, detail, source, risk;
        QVariantList secretFields; // [{name, label}]
        bool ticked = true;
        QHash<QString, QString> secrets;
    };
    static void wipeSecrets(Item& item);
    void wipeSecrets();

    QList<Item> m_items;
    QString m_cardId;
    QString m_turnId;
    qint64 m_expiresAt = 0;
    int m_secondsLeft = -1;
    bool m_exclusive = false;
    QTimer m_timer;
    std::function<qint64()> m_now;
};
