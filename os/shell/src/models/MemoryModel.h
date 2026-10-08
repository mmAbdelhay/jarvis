#pragma once

#include <QAbstractListModel>
#include <QJsonArray>
#include <QtQml/qqmlregistration.h>

// What Jarvis remembers (design §3.9; contracts §2 memory:list/delete/clear),
// newest first. A row disappears only once jarvisd confirms the delete.
class MemoryModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY changed)
    Q_PROPERTY(bool loading READ loading NOTIFY changed)
    Q_PROPERTY(QString error READ error NOTIFY changed)
    Q_PROPERTY(int count READ count NOTIFY changed)

public:
    static constexpr int kLimit = 500;
    enum Role { IdRole = Qt::UserRole + 1, KindRole, KindLabelRole, TextRole, CreatedAtRole, TimeTextRole };
    Q_ENUM(Role)

    explicit MemoryModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    bool known() const { return m_known; }
    bool loading() const { return m_loading; }
    QString error() const { return m_error; }
    int count() const { return int(m_items.size()); }

    Q_INVOKABLE void setEnabled(bool enabled);
    Q_INVOKABLE void refresh();
    Q_INVOKABLE void remove(int row);
    Q_INVOKABLE void clearAll();
    Q_INVOKABLE void applyItems(const QJsonArray& items);
    Q_INVOKABLE void applyDeleted(const QString& id);
    Q_INVOKABLE void applyCleared();
    Q_INVOKABLE void applyError(const QString& text);

signals:
    void setEnabledRequested(bool enabled);
    void changed();
    void listRequested(int limit);
    void deleteRequested(const QString& id);
    void clearRequested();

private:
    struct Item {
        QString id, kind, text;
        double createdAt = 0;
    };
    QList<Item> m_items;
    bool m_known = false;
    bool m_loading = false;
    QString m_error;
};
