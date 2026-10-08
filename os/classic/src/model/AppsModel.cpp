#include "AppsModel.h"

#include <QCollator>
#include <QFileInfo>
#include <QLocale>
#include <QStandardPaths>
#include <algorithm>

#include "Language.h"

using namespace Qt::StringLiterals;

AppsModel::AppsModel(QStringList dirs, QStringList desktops, QObject* parent)
    : QAbstractListModel(parent)
    , m_dirs(std::move(dirs))
    , m_desktops(std::move(desktops))
{
    reload();
}

QStringList AppsModel::currentDesktops()
{
    return qEnvironmentVariable("XDG_CURRENT_DESKTOP").split(u':', Qt::SkipEmptyParts);
}

bool AppsModel::usable(const jarvis::ui::DesktopEntry& e) const
{
    if (e.type != u"Application" || e.hidden || e.noDisplay || !jarvis::ui::splitExec(e.exec))
        return false;
    if (!e.tryExec.isEmpty()) {
        const bool found = e.tryExec.startsWith(u'/') ? QFileInfo(e.tryExec).isExecutable()
                                                      : !QStandardPaths::findExecutable(e.tryExec).isEmpty();
        if (!found)
            return false;
    }
    const auto shares = [this](const QStringList& list) {
        return std::any_of(list.cbegin(), list.cend(), [this](const QString& d) {
            return m_desktops.contains(d, Qt::CaseInsensitive);
        });
    };
    if (!e.onlyShowIn.isEmpty() && !shares(e.onlyShowIn))
        return false;
    return !shares(e.notShowIn);
}

void AppsModel::reload()
{
    QList<jarvis::ui::DesktopEntry> all;
    for (const jarvis::ui::DesktopEntry& e : jarvis::ui::readDesktopEntries(m_dirs))
        if (usable(e))
            all.append(e);
    m_all = all;
    rebuild();
}

void AppsModel::retranslate()
{
    rebuild();
}

void AppsModel::setFilter(const QString& filter)
{
    if (filter == m_filter)
        return;
    m_filter = filter;
    emit filterChanged();
    rebuild();
}

void AppsModel::rebuild()
{
    const QString lang = jarvis::ui::currentLanguage();
    const QString needle = m_filter.trimmed();
    QList<int> rows;
    for (int i = 0; i < m_all.size(); ++i) {
        const jarvis::ui::DesktopEntry& e = m_all.at(i);
        if (needle.isEmpty() || e.name(lang).contains(needle, Qt::CaseInsensitive)
            || e.name(QString()).contains(needle, Qt::CaseInsensitive)
            || e.comment(lang).contains(needle, Qt::CaseInsensitive))
            rows.append(i);
    }
    QCollator collator(lang == u"ar" ? QLocale(QLocale::Arabic) : QLocale(QLocale::English));
    collator.setCaseSensitivity(Qt::CaseInsensitive);
    std::stable_sort(rows.begin(), rows.end(), [&](int a, int b) {
        return collator.compare(m_all.at(a).name(lang), m_all.at(b).name(lang)) < 0;
    });
    const int before = int(m_rows.size());
    beginResetModel();
    m_rows = rows;
    endResetModel();
    if (before != m_rows.size())
        emit countChanged();
}

int AppsModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_rows.size());
}

QVariant AppsModel::data(const QModelIndex& index, int role) const
{
    if (!index.isValid() || index.row() >= m_rows.size())
        return {};
    const jarvis::ui::DesktopEntry& e = m_all.at(m_rows.at(index.row()));
    const QString lang = jarvis::ui::currentLanguage();
    switch (role) {
    case AppIdRole: return e.id;
    case NameRole: return e.name(lang);
    case CommentRole: return e.comment(lang);
    case IconRole: return e.icon;
    default: return {};
    }
}

QHash<int, QByteArray> AppsModel::roleNames() const
{
    return {{AppIdRole, "appId"}, {NameRole, "name"}, {CommentRole, "comment"}, {IconRole, "icon"}};
}

std::optional<jarvis::ui::DesktopEntry> AppsModel::entry(const QString& id) const
{
    for (const jarvis::ui::DesktopEntry& e : m_all)
        if (e.id == id)
            return e;
    return std::nullopt;
}

QString AppsModel::idAt(int row) const
{
    return row >= 0 && row < m_rows.size() ? m_all.at(m_rows.at(row)).id : QString();
}
