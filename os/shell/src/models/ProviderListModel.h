#pragma once

#include <QAbstractListModel>
#include <QJsonArray>
#include <QJsonObject>
#include <QtQml/qqmlregistration.h>

// The providers Jarvis fails over through, in order (Rafiq M2.5 contracts §1,
// §2 provider:list/provider:save), and the cloud-fallback switch. Holds the
// edited order until Save; provider:save answers per provider, and a failure
// of any one saves nothing (the row shows why).
class ProviderListModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY changed)
    Q_PROPERTY(int count READ count NOTIFY changed)
    Q_PROPERTY(bool allowCloudFallback READ allowCloudFallback WRITE setAllowCloudFallback NOTIFY changed)
    Q_PROPERTY(bool dirty READ dirty NOTIFY changed)
    Q_PROPERTY(bool saving READ saving NOTIFY changed)
    Q_PROPERTY(QString statusText READ statusText NOTIFY changed)
    Q_PROPERTY(QString activeId READ activeId NOTIFY changed)

public:
    enum Role { IdRole = Qt::UserRole + 1, KindRole, BaseUrlRole, ModelRole, HasKeyRole, LabelRole, ModeRole, ActiveRole, ErrorRole };
    Q_ENUM(Role)

    explicit ProviderListModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    bool known() const { return m_known; }
    int count() const { return int(m_rows.size()); }
    bool allowCloudFallback() const { return m_allowCloudFallback; }
    void setAllowCloudFallback(bool allow);
    bool dirty() const { return m_dirty; }
    bool saving() const { return m_saving; }
    QString statusText() const { return m_status; }
    QString activeId() const; // the provider in use: activeId if listed, else the first

    Q_INVOKABLE void loadList(const QJsonObject& list);
    Q_INVOKABLE void moveUp(int row);
    Q_INVOKABLE void moveDown(int row);
    Q_INVOKABLE void remove(int row);
    Q_INVOKABLE void save();
    Q_INVOKABLE QJsonObject config(int row) const; // {id, kind, baseUrl, model, hasKey}
    Q_INVOKABLE void applySaveResult(const QJsonObject& result);
    Q_INVOKABLE void applyRequestError(const QString& text);

    void setActiveId(const QString& id);
    QJsonObject configFor(const QString& id) const;
    QString displayName(const QString& id) const; // "model · label"
    QString uniqueId(const QString& base) const;
    QJsonObject payload() const;
    QJsonObject payloadWith(const QJsonObject& draft) const; // replaces the row with draft.id, or appends
    // provider:save's answer seen from one provider, as a ProbeResult for ProviderModel.
    static QJsonObject resultFor(const QJsonObject& saveResult, const QString& id);

signals:
    void changed();
    void saveRequested(const QJsonObject& payload);
    void saved();

private:
    struct Row {
        QString id, kind, baseUrl, model;
        bool hasKey = false;
        QString error;
        QString account;
    };
    QJsonArray rowsJson() const;
    void markDirty();

    QList<Row> m_rows;
    QString m_activeId;
    bool m_known = false;
    bool m_allowCloudFallback = false;
    bool m_dirty = false;
    bool m_saving = false;
    QString m_status;
};
