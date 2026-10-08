#include "models/Conversation.h"
#include "models/SettingChange.h"

using namespace Qt::StringLiterals;

Conversation::Conversation(QObject* parent)
    : QAbstractListModel(parent)
{
}

int Conversation::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_entries.size());
}

QVariant Conversation::data(const QModelIndex& index, int role) const
{
    if (!checkIndex(index, CheckIndexOption::IndexIsValid | CheckIndexOption::ParentIsInvalid))
        return {};
    const Entry& entry = m_entries.at(index.row());
    switch (role) {
    case KindRole: return entry.kind;
    case Qt::DisplayRole:
    case TextRole: return entry.text;
    case TurnIdRole: return entry.turnId;
    case CallIdRole: return entry.callId;
    case ToolNameRole: return entry.toolName;
    case ToolStatusRole: return entry.toolStatus;
    case ChangeFromRole:
    case ChangeToRole: {
        if (entry.kind != u"tool")
            return QString();
        const auto change = settingChange(entry.toolName, entry.text);
        return change ? (role == ChangeFromRole ? change->first : change->second) : QString();
    }
    default: return {};
    }
}

QHash<int, QByteArray> Conversation::roleNames() const
{
    return {{KindRole, "kind"}, {TextRole, "text"}, {TurnIdRole, "turnId"},
            {CallIdRole, "callId"}, {ToolNameRole, "toolName"}, {ToolStatusRole, "toolStatus"}, {ChangeFromRole, "changeFrom"}, {ChangeToRole, "changeTo"}};
}

QVariantMap Conversation::get(int row) const
{
    QVariantMap out;
    if (row < 0 || row >= m_entries.size())
        return out;
    const QHash<int, QByteArray> roles = roleNames();
    for (auto it = roles.cbegin(); it != roles.cend(); ++it)
        out.insert(QString::fromLatin1(it.value()), data(index(row), it.key()));
    return out;
}

void Conversation::append(const Entry& entry)
{
    const int row = int(m_entries.size());
    beginInsertRows({}, row, row);
    m_entries.append(entry);
    endInsertRows();
}

void Conversation::setActiveTurn(const QString& turnId)
{
    if (m_activeTurnId == turnId)
        return;
    m_activeTurnId = turnId;
    emit activeTurnChanged();
}

void Conversation::addNotice(const QString& text)
{
    append({u"notice"_s, text});
}

void Conversation::markInterrupted()
{
    if (!busy())
        return;
    addNotice(u"Lost the connection to Jarvis during this answer."_s);
    setActiveTurn({});
}

void Conversation::applyEvent(const QJsonObject& event)
{
    const QString type = event.value("type").toString();
    const QString turnId = event.value("turnId").toString();
    if (type == u"turn-start") {
        append({u"user"_s, event.value("text").toString(), turnId});
        setActiveTurn(turnId);
    } else if (type == u"text") {
        const QString delta = event.value("delta").toString();
        if (delta.isEmpty())
            return;
        if (!m_entries.isEmpty() && m_entries.last().kind == u"assistant" && m_entries.last().turnId == turnId) {
            m_entries.last().text += delta;
            const QModelIndex last = index(int(m_entries.size()) - 1);
            emit dataChanged(last, last, {TextRole, Qt::DisplayRole});
        } else {
            append({u"assistant"_s, delta, turnId});
        }
    } else if (type == u"tool") {
        const QString callId = event.value("callId").toString();
        const QString status = event.value("status").toString();
        if (callId.isEmpty() || !(status == u"running" || status == u"ok" || status == u"error"))
            return;
        const QString summary = event.value("summary").toString();
        for (qsizetype row = m_entries.size() - 1; row >= 0; --row) {
            Entry& entry = m_entries[row];
            if (entry.kind == u"tool" && entry.callId == callId) {
                entry.toolStatus = status;
                entry.text = summary;
                emit dataChanged(index(int(row)), index(int(row)), {TextRole, Qt::DisplayRole, ToolStatusRole, ChangeFromRole, ChangeToRole});
                return;
            }
        }
        append({u"tool"_s, summary, turnId, callId, event.value("name").toString(), status});
    } else if (type == u"turn-end") {
        const QString reason = event.value("reason").toString();
        if (reason == u"stopped") {
            addNotice(u"Stopped."_s);
        } else if (reason == u"step-limit") {
            addNotice(u"Stopped after 20 steps. The messages above say what was done and what is left."_s);
        } else if (reason == u"error") {
            const QString error = event.value("error").toString();
            addNotice(error.isEmpty() ? u"Something went wrong."_s : u"Something went wrong: %1"_s.arg(error));
        }
        if (turnId == m_activeTurnId)
            setActiveTurn({});
    }
}
