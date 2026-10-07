#include "InstallProgress.h"

#include <QJsonObject>
#include <QVariantMap>
#include <algorithm>

using namespace Qt::StringLiterals;

InstallProgress::InstallProgress(QObject* parent)
    : QObject(parent)
{
}

QVariantList InstallProgress::rows() const
{
    QVariantList out;
    for (const Row& r : m_rows)
        out.append(QVariantMap{{u"stepId"_s, r.stepId}, {u"title"_s, r.title}, {u"state"_s, r.state}});
    return out;
}

void InstallProgress::setPlanSteps(const QJsonArray& steps)
{
    m_rows.clear();
    m_modelTitle.clear();
    for (const QJsonValue& value : steps) {
        const QJsonObject s = value.toObject();
        const QString id = s.value("stepId").toString();
        if (id == u"model")
            m_modelTitle = s.value("title").toString();
        else if (!id.isEmpty())
            m_rows.append({id, s.value("title").toString(), u"pending"_s});
    }
    m_currentTitle.clear();
    m_currentDetail.clear();
    m_currentPercent = 0;
    m_modelPercent = 0;
    m_modelDetail.clear();
    m_done = m_failed = false;
    m_failTitle.clear();
    m_failMessage.clear();
    m_finishNote.clear();
    emit changed();
}

void InstallProgress::applyProgress(const QString& stepId, int percent, const QString& detail)
{
    if (m_done || m_failed)
        return;
    if (stepId == u"model")
        return applyModelProgress(percent, detail);
    const auto it = std::find_if(m_rows.begin(), m_rows.end(), [&](const Row& r) { return r.stepId == stepId; });
    if (it == m_rows.end())
        return;
    const qsizetype at = it - m_rows.begin();
    const int pct = std::clamp(percent, 0, 100);
    for (qsizetype i = 0; i < m_rows.size(); ++i)
        if (i < at)
            m_rows[i].state = u"done"_s;
    m_rows[at].state = pct >= 100 ? u"done"_s : u"running"_s;
    m_currentTitle = m_rows[at].title;
    m_currentPercent = pct;
    m_currentDetail = detail;
    emit changed();
}

void InstallProgress::applyModelProgress(int percent, const QString& detail)
{
    m_modelPercent = std::clamp(percent, 0, 100);
    m_modelDetail = detail;
    emit changed();
}

void InstallProgress::finish(bool ok, const QString& errorStep, const QString& message)
{
    if (m_done || m_failed)
        return;
    if (ok) {
        for (Row& r : m_rows)
            r.state = u"done"_s;
        m_done = true;
        m_finishNote = message;
    } else {
        auto it = std::find_if(m_rows.begin(), m_rows.end(), [&](const Row& r) { return r.stepId == errorStep; });
        if (it == m_rows.end())
            it = std::find_if(m_rows.begin(), m_rows.end(), [](const Row& r) { return r.state == u"running"; });
        if (it != m_rows.end())
            it->state = u"failed"_s;
        const QString title = it != m_rows.end() ? it->title : (errorStep.isEmpty() ? u"an unknown step"_s : errorStep);
        m_failed = true;
        m_failTitle = u"Installation stopped at: %1"_s.arg(title);
        m_failMessage = message.isEmpty() ? u"No details were given."_s : message;
    }
    emit changed();
}
