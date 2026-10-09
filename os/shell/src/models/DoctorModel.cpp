#include "models/DoctorModel.h"

#include <QJsonArray>
#include <QSet>
#include <algorithm>

using namespace Qt::StringLiterals;

namespace {
const QSet<QString> kStepIds{u"radio"_s, u"nm"_s, u"connection"_s, u"wifi"_s, u"dns"_s, u"provider"_s};
const QSet<QString> kStatuses{u"pending"_s, u"running"_s, u"ok"_s, u"problem"_s, u"fixed"_s, u"skipped"_s};

QString strengthFor(int signal)
{
    if (signal >= 70)
        return u"strong"_s;
    if (signal >= 40)
        return u"good"_s;
    return u"weak"_s;
}
} // namespace

DoctorModel::DoctorModel(QObject* parent)
    : QAbstractListModel(parent)
{
}

int DoctorModel::rowCount(const QModelIndex& parent) const
{
    return parent.isValid() ? 0 : int(m_steps.size());
}

QVariant DoctorModel::data(const QModelIndex& index, int role) const
{
    if (!checkIndex(index, CheckIndexOption::IndexIsValid | CheckIndexOption::ParentIsInvalid))
        return {};
    const Step& step = m_steps.at(index.row());
    switch (role) {
    case StepIdRole: return step.stepId;
    case Qt::DisplayRole:
    case LabelRole: return step.label;
    case StatusRole: return step.status;
    case DetailRole: return step.detail;
    case NumberRole: return index.row() + 1;
    default: return {};
    }
}

QHash<int, QByteArray> DoctorModel::roleNames() const
{
    return {{StepIdRole, "stepId"}, {LabelRole, "label"}, {StatusRole, "status"},
            {DetailRole, "detail"}, {NumberRole, "number"}};
}

void DoctorModel::applyState(const QJsonObject& state)
{
    QList<Step> steps;
    for (const QJsonValue& value : state.value("steps").toArray()) {
        const QJsonObject o = value.toObject();
        const QString id = o.value("stepId").toString();
        if (!kStepIds.contains(id))
            continue;
        const QString status = o.value("status").toString();
        steps.append({id, o.value("label").toString(), kStatuses.contains(status) ? status : u"pending"_s,
                      o.value("detail").toString()});
    }
    QList<QVariantMap> networks;
    for (const QJsonValue& value : state.value("networks").toArray()) {
        const QJsonObject o = value.toObject();
        const QString ssid = o.value("ssid").toString();
        if (ssid.isEmpty())
            continue;
        const int signal = std::clamp(o.value("signal").toInt(), 0, 100);
        networks.append({{u"ssid"_s, ssid}, {u"signal"_s, signal}, {u"security"_s, o.value("security").toString()},
                         {u"known"_s, o.value("known").toBool()}, {u"strength"_s, strengthFor(signal)}});
    }
    std::stable_sort(networks.begin(), networks.end(), [](const QVariantMap& a, const QVariantMap& b) {
        if (a[u"known"_s].toBool() != b[u"known"_s].toBool())
            return a[u"known"_s].toBool();
        return a[u"signal"_s].toInt() > b[u"signal"_s].toInt();
    });

    beginResetModel();
    m_steps = steps;
    endResetModel();
    m_started = true;
    m_active = state.value("active").toBool();
    const QString done = state.value("done").toString();
    m_done = done == u"fixed" || done == u"unfixed" ? done : QString();
    m_networks.clear();
    for (const QVariantMap& network : std::as_const(networks))
        m_networks.append(network);
    emit stateChanged();
}

void DoctorModel::start()
{
    emit startRequested();
}

void DoctorModel::skip(const QString& stepId)
{
    if (kStepIds.contains(stepId))
        emit skipRequested(stepId);
}

void DoctorModel::reset()
{
    beginResetModel();
    m_steps.clear();
    endResetModel();
    m_started = false;
    m_active = false;
    m_done.clear();
    m_networks.clear();
    emit stateChanged();
}
