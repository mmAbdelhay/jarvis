#pragma once

#include <QAbstractListModel>
#include <QJsonObject>
#include <QtQml/qqmlregistration.h>

// The chat transcript, built from `agent:events` pushes (contracts §3.3
// AgentEvent): user prompts, streamed assistant text, tool activity lines and
// shell notices. Card events are routed elsewhere (ShellController).
class Conversation : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QString activeTurnId READ activeTurnId NOTIFY activeTurnChanged)
    Q_PROPERTY(bool busy READ busy NOTIFY activeTurnChanged)

public:
    enum Role { KindRole = Qt::UserRole + 1, TextRole, TurnIdRole, CallIdRole, ToolNameRole, ToolStatusRole, ChangeFromRole, ChangeToRole };
    Q_ENUM(Role)

    explicit Conversation(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    QString activeTurnId() const { return m_activeTurnId; }
    bool busy() const { return !m_activeTurnId.isEmpty(); }

    Q_INVOKABLE void applyEvent(const QJsonObject& event);
    Q_INVOKABLE void addNotice(const QString& text);
    Q_INVOKABLE QVariantMap get(int row) const;

    // The connection dropped mid-turn: no turn-end will arrive for it.
    void markInterrupted();

signals:
    void activeTurnChanged();

private:
    struct Entry {
        QString kind;
        QString text;
        QString turnId;
        QString callId;
        QString toolName;
        QString toolStatus;
    };
    void append(const Entry& entry);
    void setActiveTurn(const QString& turnId);

    QList<Entry> m_entries;
    QString m_activeTurnId;
};
