#include "models/MemoryModel.h"

#include <QDateTime>
#include <QJsonObject>

#include "models/AuditModel.h"

using namespace Qt::StringLiterals;

MemoryModel::MemoryModel(QObject* parent)
    : QAbstractListModel(parent)
{
}

int MemoryModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_items.size());
}

QVariant MemoryModel::data(const QModelIndex& index, int role) const
{
    if (!index.isValid() || index.row() >= m_items.size())
        return {};
    const Item& item = m_items.at(index.row());
    switch (role) {
    case IdRole: return item.id;
    case KindRole: return item.kind;
    case KindLabelRole: return item.kind == u"summary" ? tr("Conversation summary") : tr("Fact");
    case TextRole: return item.text;
    case CreatedAtRole: return item.createdAt;
    case TimeTextRole: return AuditModel::formatTime(qint64(item.createdAt), QDateTime::currentDateTime());
    default: return {};
    }
}

QHash<int, QByteArray> MemoryModel::roleNames() const
{
    return {{IdRole, "memoryId"}, {KindRole, "kind"}, {KindLabelRole, "kindLabel"},
            {TextRole, "text"}, {CreatedAtRole, "createdAt"}, {TimeTextRole, "timeText"}};
}

void MemoryModel::setEnabled(bool enabled)
{
    emit setEnabledRequested(enabled);
}

void MemoryModel::refresh()
{
    m_loading = true;
    emit changed();
    emit listRequested(kLimit);
}

void MemoryModel::remove(int row)
{
    if (row < 0 || row >= m_items.size())
        return;
    emit deleteRequested(m_items.at(row).id);
}

void MemoryModel::clearAll()
{
    if (!m_items.isEmpty())
        emit clearRequested();
}

void MemoryModel::applyItems(const QJsonArray& items)
{
    beginResetModel();
    m_items.clear();
    for (const QJsonValue& value : items) {
        const QJsonObject o = value.toObject();
        const QString id = o.value("id").toString();
        const QString kind = o.value("kind").toString();
        if (id.isEmpty() || (kind != u"summary" && kind != u"fact"))
            continue;
        if (!o.value("text").isString() || !o.value("createdAt").isDouble())
            continue;
        m_items.append(Item{id, kind, o.value("text").toString(), o.value("createdAt").toDouble()});
    }
    endResetModel();
    m_known = true;
    m_loading = false;
    m_error.clear();
    emit changed();
}

void MemoryModel::applyDeleted(const QString& id)
{
    for (qsizetype i = 0; i < m_items.size(); ++i) {
        if (m_items.at(i).id != id)
            continue;
        beginRemoveRows({}, int(i), int(i));
        m_items.removeAt(i);
        endRemoveRows();
        m_error.clear();
        emit changed();
        return;
    }
}

void MemoryModel::applyCleared()
{
    beginResetModel();
    m_items.clear();
    endResetModel();
    m_error.clear();
    emit changed();
}

void MemoryModel::applyError(const QString& text)
{
    m_known = true;
    m_loading = false;
    m_error = text.isEmpty() ? tr("Jarvis couldn't reach its memory.") : text;
    emit changed();
}
