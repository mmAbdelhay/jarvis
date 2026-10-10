#include "models/CuSessionModel.h"

#include <QJsonArray>
#include <algorithm>

using namespace Qt::StringLiterals;

namespace {
constexpr int kMaxSessionId = 64;
constexpr int kMaxGoal = 300;
constexpr int kMaxTitle = 160;
constexpr int kMaxApp = 64;
constexpr int kMaxApps = 8;
constexpr int kMaxRows = 100;
constexpr int kMaxSteps = 50; // contracts §2 maxSteps: 50 (design §2.7)
constexpr int kMaxReason = 32;

bool knownStatus(const QString& s)
{
    return s == u"done" || s == u"running" || s == u"pending" || s == u"failed";
}
} // namespace

CuSessionModel::CuSessionModel(QObject* parent)
    : QAbstractListModel(parent)
{
}

int CuSessionModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_steps.size());
}

QVariant CuSessionModel::data(const QModelIndex& index, int role) const
{
    if (!index.isValid() || index.row() >= m_steps.size())
        return {};
    const Step& step = m_steps.at(index.row());
    switch (role) {
    case TitleRole: return step.title;
    case StatusRole: return step.status;
    case StatusLabelRole: return statusLabel(step.status);
    default: return {};
    }
}

QHash<int, QByteArray> CuSessionModel::roleNames() const
{
    return {{TitleRole, "title"}, {StatusRole, "status"}, {StatusLabelRole, "statusLabel"}};
}

QString CuSessionModel::cleanText(const QString& raw, int maxLength)
{
    if (maxLength <= 0)
        return {};
    QString out;
    const QString simple = raw.simplified();
    out.reserve(simple.size());
    // Classify full code points so supplementary format characters are removed too.
    for (const char32_t c : simple.toUcs4()) {
        const QChar::Category category = QChar::category(c);
        if (category == QChar::Other_Control || category == QChar::Other_Format)
            continue;
        out.append(QString::fromUcs4(&c, 1));
    }
    out = out.simplified();
    if (out.size() > maxLength) {
        qsizetype keep = maxLength - 1;
        if (keep > 0 && out.at(keep - 1).isHighSurrogate())
            --keep; // never split a surrogate pair
        out = out.left(keep) + u'…';
    }
    return out;
}

void CuSessionModel::applyState(const QJsonObject& s)
{
    const QJsonValue active = s.value("active");
    if (!active.isBool())
        return; // not a cu:state
    const bool wasRunning = running();
    if (!active.toBool()) {
        clear();
    } else {
        m_active = true;
        m_connectionLost = false;
        m_sessionId = cleanText(s.value("sessionId").toString(), kMaxSessionId);
        m_goal = cleanText(s.value("goal").toString(), kMaxGoal);
        m_apps.clear();
        for (const QJsonValue& app : s.value("apps").toArray()) {
            const QString name = cleanText(app.toString(), kMaxApp);
            if (!name.isEmpty() && m_apps.size() < kMaxApps)
                m_apps.append(name);
        }
        const int maxSteps = s.value("maxSteps").toInt(kMaxSteps);
        m_maxSteps = maxSteps >= 1 && maxSteps <= kMaxSteps ? maxSteps : kMaxSteps;
        m_step = std::clamp(s.value("step").toInt(0), 0, m_maxSteps);
        const QJsonValue paused = s.value("paused");
        m_paused = !paused.isNull() && !paused.isUndefined();
        m_pauseReason = paused.isString() ? cleanText(paused.toString(), kMaxReason) : QString();

        QList<Step> rows;
        const QJsonArray steps = s.value("steps").toArray();
        for (qsizetype i = std::max<qsizetype>(0, steps.size() - kMaxRows); i < steps.size(); ++i) {
            const QJsonObject o = steps.at(i).toObject();
            const QString status = o.value("status").toString();
            rows.append(Step{cleanText(o.value("title").toString(), kMaxTitle),
                             knownStatus(status) ? status : u"pending"_s});
        }
        beginResetModel();
        m_steps = rows;
        endResetModel();
    }
    emit changed();
    if (running() != wasRunning)
        emit runningChanged();
}

void CuSessionModel::clear()
{
    beginResetModel();
    m_steps.clear();
    endResetModel();
    m_active = false;
    m_paused = false;
    m_connectionLost = false;
    m_pending = Pending::None;
    m_sessionId.clear();
    m_goal.clear();
    m_apps.clear();
    m_step = 0;
    m_maxSteps = kMaxSteps;
    m_pauseReason.clear();
    m_error.clear();
}

void CuSessionModel::stop()
{
    if (!m_active || m_connectionLost || busy())
        return;
    m_pending = Pending::Stop;
    m_error.clear();
    emit changed();
    emit stopRequested();
}

void CuSessionModel::resume()
{
    if (!m_active || !m_paused || m_connectionLost || busy())
        return;
    m_pending = Pending::Resume;
    m_error.clear();
    emit changed();
    emit resumeRequested();
}

void CuSessionModel::applyRequestResult(bool ok, const QString& text)
{
    if (!busy())
        return;
    if (!ok)
        m_error = m_pending == Pending::Stop ? tr("Couldn't stop Jarvis: %1").arg(text)
                                             : tr("Couldn't resume: %1").arg(text);
    m_pending = Pending::None;
    emit changed();
}

void CuSessionModel::connectionClosed()
{
    if (!m_active || m_connectionLost)
        return;
    const bool wasRunning = running();
    m_connectionLost = true;
    m_pending = Pending::None;
    emit changed();
    if (running() != wasRunning)
        emit runningChanged();
}

void CuSessionModel::connectionOpened()
{
    if (!m_connectionLost)
        return;
    clear(); // jarvisd pushes cu:state again if a session is still running
    emit changed();
}

QString CuSessionModel::appsText() const
{
    return m_apps.join(tr(", "));
}

QString CuSessionModel::statusText() const
{
    if (!m_active)
        return {};
    if (m_connectionLost)
        return tr("Lost the connection to Jarvis. Reconnecting…");
    if (m_paused)
        return tr("Paused · you have control");
    return tr("Jarvis is controlling the screen · step %1 of %2").arg(m_step).arg(m_maxSteps);
}

QString CuSessionModel::detailText() const
{
    if (!m_paused)
        return m_error;
    if (m_pauseReason == u"physical-input")
        return tr("You moved the mouse or typed.");
    if (m_pauseReason == u"esc")
        return tr("You pressed Esc.");
    if (m_pauseReason == u"excluded-focus")
        return tr("A protected window has focus.");
    if (m_pauseReason == u"locked")
        return tr("The screen locked.");
    return tr("Jarvis paused.");
}

QString CuSessionModel::statusLabel(const QString& status) const
{
    if (status == u"done")
        return tr("Done");
    if (status == u"running")
        return tr("Running");
    if (status == u"failed")
        return tr("Failed");
    return tr("Waiting");
}
