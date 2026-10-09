#pragma once

#include <QAbstractListModel>
#include <QJsonObject>
#include <QStringList>
#include <QtQml/qqmlregistration.h>
#include <optional>

// Tool servers from the registry (design §3.7; contracts §2 registry:list,
// §3 RegistryEntry): installed first, then available. Installing or removing
// one is a chat request that comes back as an approval card, so this model
// only emits validated ids and versions; names and descriptions never leave it.
class RegistryModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY changed)
    Q_PROPERTY(bool loading READ loading NOTIFY changed)
    Q_PROPERTY(QString error READ error NOTIFY changed)
    Q_PROPERTY(int count READ count NOTIFY changed)
    Q_PROPERTY(QString filter READ filter WRITE setFilter NOTIFY changed)

public:
    enum Role {
        EntryIdRole = Qt::UserRole + 1, NameRole, DescriptionRole, TierRole, TierLabelRole, TierDetailRole,
        VersionRole, InstalledVersionRole, InstallStateRole, PermissionsTextRole, ToolsTextRole
    };
    Q_ENUM(Role)

    explicit RegistryModel(QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    bool known() const { return m_known; }
    bool loading() const { return m_loading; }
    QString error() const { return m_error; }
    int count() const { return int(m_visible.size()); }
    QString filter() const { return m_filter; }
    void setFilter(const QString& filter);

    Q_INVOKABLE void refresh();
    Q_INVOKABLE void applyList(const QJsonObject& list);
    Q_INVOKABLE void applyError(const QString& text);
    Q_INVOKABLE void install(int row);
    Q_INVOKABLE void remove(int row);

    static bool validId(const QString& id);
    static bool validVersion(const QString& version);

signals:
    void changed();
    void listRequested();
    void installRequested(const QString& id, const QString& version);
    void removeRequested(const QString& id);

private:
    struct Entry {
        QString id, name, description, tier, version, installedVersion;
        bool network = false;
        QStringList paths, tools;
    };
    static std::optional<Entry> parseEntry(const QJsonObject& o);
    static QString stateOf(const Entry& e);
    const Entry* entryAt(int row) const;
    void rebuildVisible();

    QList<Entry> m_all;
    QList<int> m_visible;
    QString m_filter;
    bool m_known = false;
    bool m_loading = false;
    QString m_error;
};
