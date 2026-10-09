#pragma once

#include <QAbstractListModel>
#include <QStringList>
#include <QtQml/qqmlregistration.h>
#include <optional>

#include "DesktopEntry.h"

// The classic Apps menu (Rafiq M4 contracts §2): visible .desktop applications
// in XDG order, names in the UI language, filtered by the search box.
class AppsModel : public QAbstractListModel {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by ClassicController")
    Q_PROPERTY(QString filter READ filter WRITE setFilter NOTIFY filterChanged)
    Q_PROPERTY(int count READ count NOTIFY countChanged)

public:
    enum Role { AppIdRole = Qt::UserRole + 1, NameRole, CommentRole, IconRole };

    AppsModel(QStringList dirs, QStringList desktops, QObject* parent = nullptr);

    int rowCount(const QModelIndex& parent = {}) const override;
    QVariant data(const QModelIndex& index, int role) const override;
    QHash<int, QByteArray> roleNames() const override;

    QString filter() const { return m_filter; }
    void setFilter(const QString& filter);
    int count() const { return rowCount(); }

    void reload();
    void retranslate();
    std::optional<jarvis::ui::DesktopEntry> entry(const QString& id) const;
    QString idAt(int row) const;

    static QStringList currentDesktops();

signals:
    void filterChanged();
    void countChanged();

private:
    bool usable(const jarvis::ui::DesktopEntry& e) const;
    void rebuild();

    QStringList m_dirs;
    QStringList m_desktops;
    QList<jarvis::ui::DesktopEntry> m_all;
    QList<int> m_rows; // indexes into m_all, filtered and sorted
    QString m_filter;
};
