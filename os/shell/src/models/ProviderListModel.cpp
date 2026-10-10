#include "models/ProviderListModel.h"

#include "models/ProviderModel.h"

using namespace Qt::StringLiterals;

ProviderListModel::ProviderListModel(QObject* parent)
    : QAbstractListModel(parent)
{
}

int ProviderListModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_rows.size());
}

QVariant ProviderListModel::data(const QModelIndex& index, int role) const
{
    if (!index.isValid() || index.row() >= m_rows.size())
        return {};
    const Row& row = m_rows.at(index.row());
    switch (role) {
    case IdRole: return row.id;
    case KindRole: return row.kind;
    case BaseUrlRole: return row.baseUrl;
    case ModelRole: return row.model;
    case HasKeyRole: return row.hasKey;
    case LabelRole: return ProviderModel::providerLabel(row.kind, row.baseUrl);
    case ModeRole: return ProviderModel::providerMode(row.kind, row.baseUrl);
    case ActiveRole: return row.id == activeId();
    case ErrorRole: return row.error;
    default: return {};
    }
}

QHash<int, QByteArray> ProviderListModel::roleNames() const
{
    return {{IdRole, "providerId"}, {KindRole, "kind"}, {BaseUrlRole, "baseUrl"}, {ModelRole, "modelName"},
            {HasKeyRole, "hasKey"}, {LabelRole, "label"}, {ModeRole, "mode"}, {ActiveRole, "active"}, {ErrorRole, "error"}};
}

QString ProviderListModel::activeId() const
{
    for (const Row& row : m_rows)
        if (row.id == m_activeId)
            return m_activeId;
    return m_rows.isEmpty() ? QString() : m_rows.first().id;
}

void ProviderListModel::loadList(const QJsonObject& list)
{
    beginResetModel();
    m_rows.clear();
    const QJsonValue providers = list.value("providers");
    if (providers.isArray()) {
        for (const QJsonValue& value : providers.toArray()) {
            const QJsonObject o = value.toObject();
            Row row{o.value("id").toString(), o.value("kind").toString(), o.value("baseUrl").toString(),
                    o.value("model").toString(), o.value("hasKey").toBool(), {}};
            row.account = o.value("account").toString();
            if (!row.id.isEmpty() && !row.kind.isEmpty())
                m_rows.append(row);
        }
        m_activeId = list.value("activeId").toString();
    } else if (list.value("active").isObject()) { // a jarvisd from before M2.5
        const QJsonObject o = list.value("active").toObject();
        m_rows.append(Row{u"default"_s, o.value("kind").toString(), o.value("baseUrl").toString(),
                          o.value("model").toString(), o.value("hasKey").toBool(), {}});
        m_activeId.clear();
    }
    m_allowCloudFallback = list.value("allowCloudFallback").toBool();
    m_known = true;
    m_dirty = false;
    m_saving = false;
    endResetModel();
    emit changed();
}

void ProviderListModel::markDirty()
{
    m_dirty = true;
    m_status.clear();
    emit changed();
}

void ProviderListModel::setAllowCloudFallback(bool allow)
{
    if (allow == m_allowCloudFallback)
        return;
    m_allowCloudFallback = allow;
    markDirty();
}

void ProviderListModel::moveUp(int row)
{
    if (row <= 0 || row >= m_rows.size() || m_saving)
        return;
    beginMoveRows({}, row, row, {}, row - 1);
    m_rows.swapItemsAt(row, row - 1);
    endMoveRows();
    markDirty();
}

void ProviderListModel::moveDown(int row)
{
    if (row < 0 || row >= m_rows.size() - 1 || m_saving)
        return;
    beginMoveRows({}, row, row, {}, row + 2);
    m_rows.swapItemsAt(row, row + 1);
    endMoveRows();
    markDirty();
}

void ProviderListModel::remove(int row)
{
    if (row < 0 || row >= m_rows.size() || m_saving)
        return;
    if (m_rows.size() == 1) {
        m_status = tr("Jarvis needs at least one provider.");
        emit changed();
        return;
    }
    beginRemoveRows({}, row, row);
    m_rows.removeAt(row);
    endRemoveRows();
    markDirty();
}

QJsonArray ProviderListModel::rowsJson() const
{
    QJsonArray out;
    for (const Row& row : m_rows) {
        QJsonObject o{{"id", row.id}, {"kind", row.kind}, {"baseUrl", row.baseUrl}, {"model", row.model}};
        if (row.kind == u"account")
            o.insert("account", row.account);
        out.append(o);
    }
    return out;
}

QJsonObject ProviderListModel::payload() const
{
    return {{"providers", rowsJson()}, {"allowCloudFallback", m_allowCloudFallback}};
}

QJsonObject ProviderListModel::payloadWith(const QJsonObject& draft) const
{
    QJsonArray providers = rowsJson();
    const QString id = draft.value("id").toString();
    bool replaced = false;
    for (qsizetype i = 0; i < providers.size(); ++i) {
        if (providers.at(i).toObject().value("id").toString() == id) {
            providers.replace(i, draft);
            replaced = true;
        }
    }
    if (!replaced)
        providers.append(draft);
    return {{"providers", providers}, {"allowCloudFallback", m_allowCloudFallback}};
}

void ProviderListModel::save()
{
    if (!m_dirty || m_saving)
        return;
    m_saving = true;
    m_status = tr("Saving…");
    emit changed();
    emit saveRequested(payload());
}

void ProviderListModel::applySaveResult(const QJsonObject& result)
{
    m_saving = false;
    const QJsonObject results = result.value("results").toObject();
    QStringList failed;
    for (Row& row : m_rows) {
        const QJsonObject probe = results.value(row.id).toObject();
        row.error = probe.isEmpty() || probe.value("ok").toBool() ? QString()
                                                                  : probe.value("error").toString(tr("Couldn't connect."));
        if (!row.error.isEmpty())
            failed.append(row.id);
    }
    if (!m_rows.isEmpty())
        emit dataChanged(index(0), index(int(m_rows.size()) - 1), {ErrorRole});
    if (result.value("ok").toBool()) {
        m_dirty = false;
        m_status = tr("Saved.");
        emit changed();
        emit saved();
        return;
    }
    m_status = failed.isEmpty() ? tr("Nothing was saved.")
                                : tr("Nothing was saved: %1 didn't pass the check.").arg(failed.join(u", "_s));
    emit changed();
}

void ProviderListModel::applyRequestError(const QString& text)
{
    m_saving = false;
    m_status = tr("Couldn't save: %1").arg(text);
    emit changed();
}

void ProviderListModel::setActiveId(const QString& id)
{
    m_activeId = id;
    if (!m_rows.isEmpty())
        emit dataChanged(index(0), index(int(m_rows.size()) - 1), {ActiveRole});
    emit changed();
}

QJsonObject ProviderListModel::config(int row) const
{
    if (row < 0 || row >= m_rows.size())
        return {};
    const Row& r = m_rows.at(row);
    QJsonObject out{{"id", r.id}, {"kind", r.kind}, {"baseUrl", r.baseUrl}, {"model", r.model}, {"hasKey", r.hasKey}};
    if (r.kind == u"account")
        out.insert("account", r.account);
    return out;
}

QJsonObject ProviderListModel::configFor(const QString& id) const
{
    for (qsizetype i = 0; i < m_rows.size(); ++i)
        if (m_rows.at(i).id == id)
            return config(int(i));
    return {};
}

QString ProviderListModel::displayName(const QString& id) const
{
    for (const Row& row : m_rows)
        if (row.id == id)
            return u"%1 · %2"_s.arg(row.model, ProviderModel::providerLabel(row.kind, row.baseUrl));
    return id;
}

QString ProviderListModel::uniqueId(const QString& base) const
{
    const QString root = base.isEmpty() ? u"provider"_s : base;
    auto taken = [this](const QString& id) {
        for (const Row& row : m_rows)
            if (row.id == id)
                return true;
        return false;
    };
    if (!taken(root))
        return root;
    for (int n = 2;; ++n) {
        const QString candidate = u"%1-%2"_s.arg(root).arg(n);
        if (!taken(candidate))
            return candidate;
    }
}

QJsonObject ProviderListModel::resultFor(const QJsonObject& saveResult, const QString& id)
{
    if (!saveResult.contains("results"))
        return saveResult; // a jarvisd from before M2.5 answers a ProbeResult
    const QJsonObject results = saveResult.value("results").toObject();
    QJsonObject out = results.value(id).toObject();
    const bool ok = saveResult.value("ok").toBool() && out.value("ok").toBool(true);
    out.insert("ok", ok);
    if (!ok && out.value("error").toString().isEmpty()) {
        for (auto it = results.constBegin(); it != results.constEnd(); ++it) {
            const QJsonObject other = it.value().toObject();
            if (it.key() != id && !other.value("ok").toBool(true)) {
                out.insert("error", tr("Not saved: %1 didn't pass the check (%2).").arg(it.key(), other.value("error").toString()));
                break;
            }
        }
        if (out.value("error").toString().isEmpty())
            out.insert("error", tr("Couldn't save the provider."));
    }
    return out;
}
