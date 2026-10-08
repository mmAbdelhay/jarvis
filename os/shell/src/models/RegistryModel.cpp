#include "models/RegistryModel.h"

#include <QJsonArray>
#include <QRegularExpression>

using namespace Qt::StringLiterals;

RegistryModel::RegistryModel(QObject* parent)
    : QAbstractListModel(parent)
{
}

bool RegistryModel::validId(const QString& id)
{
    static const QRegularExpression pattern(u"^[a-z0-9][a-z0-9._-]{0,63}\\z"_s);
    return pattern.match(id).hasMatch() && !id.contains(u".."_s);
}

bool RegistryModel::validVersion(const QString& version)
{
    static const QRegularExpression pattern(u"^[0-9A-Za-z][0-9A-Za-z.+~-]{0,63}\\z"_s);
    return pattern.match(version).hasMatch();
}

std::optional<RegistryModel::Entry> RegistryModel::parseEntry(const QJsonObject& o)
{
    Entry e;
    e.id = o.value("id").toString();
    e.version = o.value("version").toString();
    e.tier = o.value("tier").toString();
    if (!validId(e.id) || !validVersion(e.version))
        return std::nullopt;
    if (e.tier != u"official" && e.tier != u"reviewed" && e.tier != u"community")
        return std::nullopt;
    if (e.id.startsWith(u"jarvis-") && e.tier != u"official")
        return std::nullopt;
    e.name = o.value("name").toString().trimmed();
    if (e.name.isEmpty())
        e.name = e.id;
    e.description = o.value("description").toString();
    const QJsonObject permissions = o.value("permissions").toObject();
    e.network = permissions.value("network").toBool();
    for (const QJsonValue& path : permissions.value("paths").toArray())
        if (path.isString())
            e.paths.append(path.toString());
    for (const QJsonValue& tool : o.value("tools").toArray()) {
        const QString name = tool.toObject().value("name").toString();
        if (!name.isEmpty())
            e.tools.append(name);
    }
    return e;
}

QString RegistryModel::stateOf(const Entry& e)
{
    if (e.installedVersion.isEmpty())
        return u"available"_s;
    return e.installedVersion == e.version ? u"installed"_s : u"update"_s;
}

void RegistryModel::applyList(const QJsonObject& list)
{
    QList<Entry> available;
    for (const QJsonValue& value : list.value("available").toArray())
        if (auto e = parseEntry(value.toObject()))
            available.append(*e);
    QList<Entry> merged;
    for (const QJsonValue& value : list.value("installed").toArray()) {
        auto installed = parseEntry(value.toObject());
        if (!installed)
            continue;
        Entry e = *installed;
        e.installedVersion = installed->version;
        for (const Entry& a : available) {
            if (a.id == e.id) {
                e = a;
                e.installedVersion = installed->version;
                break;
            }
        }
        merged.append(e);
    }
    for (const Entry& a : available) {
        bool listed = false;
        for (const Entry& m : merged)
            listed = listed || m.id == a.id;
        if (!listed)
            merged.append(a);
    }
    beginResetModel();
    m_all = merged;
    rebuildVisible();
    endResetModel();
    m_known = true;
    m_loading = false;
    m_error.clear();
    emit changed();
}

void RegistryModel::rebuildVisible()
{
    m_visible.clear();
    const QString needle = m_filter.trimmed();
    for (qsizetype i = 0; i < m_all.size(); ++i) {
        const Entry& e = m_all.at(i);
        if (needle.isEmpty() || e.id.contains(needle, Qt::CaseInsensitive) || e.name.contains(needle, Qt::CaseInsensitive)
            || e.description.contains(needle, Qt::CaseInsensitive))
            m_visible.append(int(i));
    }
}

void RegistryModel::setFilter(const QString& filter)
{
    if (filter == m_filter)
        return;
    beginResetModel();
    m_filter = filter;
    rebuildVisible();
    endResetModel();
    emit changed();
}

const RegistryModel::Entry* RegistryModel::entryAt(int row) const
{
    if (row < 0 || row >= m_visible.size())
        return nullptr;
    return &m_all.at(m_visible.at(row));
}

int RegistryModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_visible.size());
}

QVariant RegistryModel::data(const QModelIndex& index, int role) const
{
    const Entry* e = index.isValid() ? entryAt(index.row()) : nullptr;
    if (!e)
        return {};
    switch (role) {
    case EntryIdRole: return e->id;
    case NameRole: return e->name;
    case DescriptionRole: return e->description;
    case TierRole: return e->tier;
    case TierLabelRole:
        return e->tier == u"official" ? u"Official"_s : e->tier == u"reviewed" ? u"Reviewed"_s : u"Community"_s;
    case TierDetailRole:
        if (e->tier == u"official")
            return u"Built by the Jarvis project and signed with its packages."_s;
        if (e->tier == u"reviewed")
            return u"Checked by a reviewer before it was listed. Jarvis still asks before any change."_s;
        return u"Not reviewed. Jarvis asks you before every action it takes."_s;
    case VersionRole: return e->version;
    case InstalledVersionRole: return e->installedVersion;
    case InstallStateRole: return stateOf(*e);
    case PermissionsTextRole:
        return u"%1 · %2"_s.arg(e->network ? u"Uses the internet"_s : u"No internet access"_s,
                                e->paths.isEmpty() ? u"Can't change your files"_s
                                                   : u"Can change files in %1"_s.arg(e->paths.join(u", "_s)));
    case ToolsTextRole: return e->tools.join(u", "_s);
    default: return {};
    }
}

QHash<int, QByteArray> RegistryModel::roleNames() const
{
    return {{EntryIdRole, "entryId"}, {NameRole, "name"}, {DescriptionRole, "description"}, {TierRole, "tier"},
            {TierLabelRole, "tierLabel"}, {TierDetailRole, "tierDetail"}, {VersionRole, "version"},
            {InstalledVersionRole, "installedVersion"}, {InstallStateRole, "installState"},
            {PermissionsTextRole, "permissionsText"}, {ToolsTextRole, "toolsText"}};
}

void RegistryModel::refresh()
{
    m_loading = true;
    emit changed();
    emit listRequested();
}

void RegistryModel::applyError(const QString& text)
{
    m_known = true;
    m_loading = false;
    m_error = text.isEmpty() ? u"Couldn't load the tool registry."_s : text;
    emit changed();
}

void RegistryModel::install(int row)
{
    const Entry* e = entryAt(row);
    if (!e || stateOf(*e) == u"installed")
        return;
    emit installRequested(e->id, e->version);
}

void RegistryModel::remove(int row)
{
    const Entry* e = entryAt(row);
    if (!e || stateOf(*e) == u"available")
        return;
    emit removeRequested(e->id);
}
