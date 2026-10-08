#include "models/AuditModel.h"

#include <QJsonObject>
#include "Language.h"
#include <cmath>

using namespace Qt::StringLiterals;

AuditModel::AuditModel(QObject* parent)
    : QAbstractListModel(parent)
{
}

int AuditModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_visible.size());
}

QString AuditModel::decisionLabel(const Row& row)
{
    if (row.decision == u"approved")
        return tr("Approved");
    if (row.decision == u"denied")
        return tr("Denied");
    return tr("Timed out");
}

QString AuditModel::resultLabel(const Row& row)
{
    if (row.result == u"ok")
        return tr("Done");
    if (row.result == u"failed")
        return row.message.isEmpty() ? tr("Failed") : tr("Failed: %1").arg(row.message);
    return row.decision == u"approved" ? tr("Skipped") : tr("Nothing changed");
}

QString AuditModel::formatTime(qint64 ts, const QDateTime& now)
{
    const QDateTime when = QDateTime::fromMSecsSinceEpoch(ts).toLocalTime();
    if (when.date() == now.toLocalTime().date())
        return jarvis::ui::formatDateTime(when, u"HH:mm"_s);
    return jarvis::ui::formatDateTime(when, u"d MMM HH:mm"_s);
}

QVariant AuditModel::data(const QModelIndex& index, int role) const
{
    if (!checkIndex(index, CheckIndexOption::IndexIsValid | CheckIndexOption::ParentIsInvalid))
        return {};
    const Row& row = m_all.at(m_visible.at(index.row()));
    switch (role) {
    case TsRole: return row.ts;
    case TimeTextRole: return formatTime(qint64(row.ts), QDateTime::currentDateTime());
    case Qt::DisplayRole:
    case TitleRole: return row.title;
    case ToolRole: return row.tool;
    case ViaRole: return row.via == u"doctor" ? tr("Doctor") : tr("Desktop");
    case DecisionRole: return row.decision;
    case DecisionLabelRole: return decisionLabel(row);
    case ResultLabelRole: return resultLabel(row);
    case FailedRole: return row.result == u"failed";
    default: return {};
    }
}

QHash<int, QByteArray> AuditModel::roleNames() const
{
    return {{TsRole, "ts"}, {TimeTextRole, "timeText"}, {TitleRole, "title"}, {ToolRole, "tool"},
            {ViaRole, "via"}, {DecisionRole, "decision"}, {DecisionLabelRole, "decisionLabel"},
            {ResultLabelRole, "resultLabel"}, {FailedRole, "failed"}};
}

bool AuditModel::matches(const Row& row) const
{
    if (m_filter == u"approved")
        return row.decision == u"approved";
    if (m_filter == u"denied")
        return row.decision == u"denied" || row.decision == u"timeout";
    if (m_filter == u"failed")
        return row.result == u"failed";
    return true;
}

void AuditModel::rebuild()
{
    beginResetModel();
    m_visible.clear();
    for (int i = 0; i < m_all.size(); ++i)
        if (matches(m_all.at(i)))
            m_visible.append(i);
    endResetModel();
}

void AuditModel::setFilter(const QString& filter)
{
    if (filter == m_filter || !(filter == u"all" || filter == u"approved" || filter == u"denied" || filter == u"failed"))
        return;
    m_filter = filter;
    rebuild();
    emit filterChanged();
}

QVariantList AuditModel::recent() const
{
    QVariantList out;
    const QDateTime now = QDateTime::currentDateTime();
    for (int i = 0; i < m_all.size() && out.size() < 3; ++i) {
        const Row& row = m_all.at(i);
        QString text = row.title;
        if (row.decision == u"denied")
            text = tr("Denied: %1").arg(row.title);
        else if (row.decision == u"timeout")
            text = tr("Timed out: %1").arg(row.title);
        else if (row.result == u"failed")
            text = tr("Failed: %1").arg(row.title);
        out.append(QVariantMap{{u"text"_s, text}, {u"timeText"_s, formatTime(qint64(row.ts), now)}});
    }
    return out;
}

void AuditModel::refresh()
{
    m_loading = true;
    emit entriesChanged();
    emit listRequested(kPageSize, 0);
}

void AuditModel::loadMore()
{
    if (m_all.isEmpty() || !m_hasMore || m_loading)
        return;
    m_loading = true;
    emit entriesChanged();
    emit listRequested(kPageSize, m_all.last().ts);
}

void AuditModel::applyEntries(const QJsonArray& entries, bool append)
{
    QList<Row> parsed;
    for (const QJsonValue& value : entries) {
        const QJsonObject o = value.toObject();
        const QString decision = o.value("decision").toString();
        if (!(decision == u"approved" || decision == u"denied" || decision == u"timeout"))
            continue;
        // contracts §3.3 / §6.23: ts is epoch milliseconds on the control socket.
        const double ts = o.value("ts").isDouble() ? o.value("ts").toDouble() : -1;
        if (!std::isfinite(ts) || ts < 0)
            continue;
        parsed.append({ts, o.value("tool").toString(), o.value("title").toString(),
                       o.value("via").toString(), decision, o.value("result").toString(), o.value("message").toString()});
    }
    if (!append)
        m_all.clear();
    m_all.append(parsed);
    m_hasMore = entries.size() >= kPageSize;
    m_loading = false;
    rebuild();
    emit entriesChanged();
}

void AuditModel::applyError(const QString& text)
{
    Q_UNUSED(text)
    m_loading = false;
    emit entriesChanged();
}
