#pragma once

#include <QAbstractListModel>
#include <QDateTime>
#include <QJsonArray>
#include <QtQml/qqmlregistration.h>

// The activity log (contracts §3.3 AuditEntry, newest first), with the
// design's filters and the "recent actions" list for the side panel.
class AuditModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QString filter READ filter WRITE setFilter NOTIFY filterChanged)
    Q_PROPERTY(bool hasMore READ hasMore NOTIFY entriesChanged)
    Q_PROPERTY(bool loading READ loading NOTIFY entriesChanged)
    Q_PROPERTY(QVariantList recent READ recent NOTIFY entriesChanged)

public:
    static constexpr int kPageSize = 200;
    enum Role {
        TsRole = Qt::UserRole + 1, TimeTextRole, TitleRole, ToolRole, ViaRole,
        DecisionRole, DecisionLabelRole, ResultLabelRole, FailedRole
    };
    Q_ENUM(Role)

    explicit AuditModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    QString filter() const { return m_filter; }
    void setFilter(const QString& filter);
    bool hasMore() const { return m_hasMore; }
    bool loading() const { return m_loading; }
    QVariantList recent() const;

    Q_INVOKABLE void refresh();
    Q_INVOKABLE void loadMore();
    Q_INVOKABLE void applyEntries(const QJsonArray& entries, bool append);
    Q_INVOKABLE void applyError(const QString& text);

    static QString formatTime(qint64 ts, const QDateTime& now);

signals:
    void filterChanged();
    void entriesChanged();
    void listRequested(int limit, double beforeTs);

private:
    struct Row {
        double ts = 0;
        QString tool, title, via, decision, result, message;
    };
    static QString decisionLabel(const Row& row);
    static QString resultLabel(const Row& row);
    bool matches(const Row& row) const;
    void rebuild();

    QList<Row> m_all;
    QList<int> m_visible;
    QString m_filter = QStringLiteral("all");
    bool m_hasMore = false;
    bool m_loading = false;
};
