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

QString voicePart(const QJsonValue& value)
{
    if (value.isString())
        return value.toString().left(80);
    return value.toBool(false) ? u"ready"_s : QString();
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

void SystemModel::setUpdateCounts(int count, int security)
{
    m_updatesCount = std::max(0, count);
    m_updatesSecurity = std::clamp(security, 0, m_updatesCount);
}

void SystemModel::applyUpdateCounts(int count, int security)
{
    setUpdateCounts(count, security);
    emit changed();
}

QString SystemModel::updatesText() const
{
    if (m_updatesCount == 0)
        return {};
    QString text = m_updatesCount == 1 ? u"1 update"_s : u"%1 updates"_s.arg(m_updatesCount);
    if (m_updatesSecurity > 0)
        text += u" · %1 security"_s.arg(m_updatesSecurity);
    return text;
}

QString SystemModel::modelDownloadText() const
{
    if (m_downloadState == u"downloading")
        return u"Downloading · %1%"_s.arg(m_downloadPercent);
    if (m_downloadState == u"pending")
        return u"Waiting for the network to download"_s;
    if (m_downloadState == u"failed")
        return u"Download failed. It will try again."_s;
    return {};
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
    const QJsonObject updates = snapshot.value("updates").toObject(); // absent from M1 daemons → 0
    setUpdateCounts(updates.value("count").toInt(), updates.value("security").toInt());
    const QJsonObject download = model.value("download").toObject();
    m_downloadState = download.value("state").toString();
    m_downloadPercent = std::clamp(int(download.value("percent").toDouble()), 0, 100);
    m_locked = snapshot.value("locked").toBool(false);
    const QJsonObject voice = snapshot.value("voice").toObject();
    m_voiceAvailable = voice.value("available").toBool(false);
    m_voiceStt = voicePart(voice.value("stt"));
    m_voiceTts = voicePart(voice.value("tts"));
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
    m_updatesCount = m_updatesSecurity = 0;
    m_downloadState.clear();
    m_downloadPercent = 0;
    m_locked = false;
    m_voiceAvailable = false;
    m_voiceStt.clear();
    m_voiceTts.clear();
    emit changed();
}
