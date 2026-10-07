#include "models/SystemModel.h"

#include <QJsonArray>
#include <QLocale>
#include <algorithm>

using namespace Qt::StringLiterals;

namespace {
double fraction(double used, double total)
{
    return total > 0 ? std::clamp(used / total, 0.0, 1.0) : 0.0;
}
} // namespace

SystemModel::SystemModel(QObject* parent)
    : QObject(parent)
{
}

QString SystemModel::formatGb(double bytes)
{
    const double gib = std::max(0.0, bytes) / (1024.0 * 1024.0 * 1024.0);
    return QLocale::c().toString(gib, 'f', gib < 10 ? 1 : 0);
}

QString SystemModel::networkText() const
{
    return m_online ? u"Online"_s : u"Offline"_s;
}

QString SystemModel::networkDetail() const
{
    if (!m_wifiSsid.isEmpty())
        return u"Wi-Fi %1 · %2"_s.arg(m_wifiSsid, m_connectivity);
    return u"connectivity: %1"_s.arg(m_connectivity.isEmpty() ? u"unknown"_s : m_connectivity);
}

QString SystemModel::memoryText() const
{
    return u"%1 / %2 GB"_s.arg(formatGb(m_memUsed), formatGb(m_memTotal));
}

double SystemModel::memoryFraction() const { return fraction(m_memUsed, m_memTotal); }

QString SystemModel::diskText() const
{
    return u"%1 / %2 GB"_s.arg(formatGb(m_diskUsed), formatGb(m_diskSize));
}

double SystemModel::diskFraction() const { return fraction(m_diskUsed, m_diskSize); }

QString SystemModel::modelDetail() const
{
    if (!hasModel())
        return {};
    return u"%1 · %2"_s.arg(m_modelLocal ? u"On your machines"_s : u"In the cloud"_s,
                            m_modelTools ? u"can control the OS"_s : u"can chat, can't control the OS"_s);
}

void SystemModel::applySnapshot(const QJsonObject& snapshot)
{
    m_known = true;
    m_online = snapshot.value("online").toBool();
    const QJsonObject network = snapshot.value("network").toObject();
    m_connectivity = network.value("connectivity").toString();
    m_wifiSsid = network.value("wifiSsid").toString(); // null → ""
    m_memTotal = snapshot.value("memTotalBytes").toDouble();
    m_memUsed = snapshot.value("memUsedBytes").toDouble();
    const QJsonObject disk = snapshot.value("disk").toObject();
    m_diskSize = disk.value("sizeBytes").toDouble();
    m_diskUsed = disk.value("usedBytes").toDouble();
    m_failedUnits.clear();
    for (const QJsonValue& unit : snapshot.value("failedUnits").toArray())
        if (unit.isString())
            m_failedUnits.append(unit.toString());
    const QJsonObject model = snapshot.value("model").toObject();
    m_modelName = model.value("model").toString();
    m_modelLocal = model.value("local").toBool();
    m_modelTools = model.value("supportsTools").toBool();
    emit changed();
}

void SystemModel::reset()
{
    m_known = false;
    m_online = true;
    m_connectivity.clear();
    m_wifiSsid.clear();
    m_memTotal = m_memUsed = m_diskSize = m_diskUsed = 0;
    m_failedUnits.clear();
    m_modelName.clear();
    emit changed();
}
