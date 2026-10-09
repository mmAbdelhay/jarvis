#include "models/SystemModel.h"

#include <QCoreApplication>
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
    return value.toBool(false) ? QCoreApplication::translate("SystemModel", "ready") : QString();
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
    return m_online ? tr("Online") : tr("Offline");
}

QString SystemModel::connectivityLabel(const QString& connectivity)
{
    if (connectivity == u"full") return tr("online");
    if (connectivity == u"limited") return tr("limited");
    if (connectivity == u"portal") return tr("sign-in needed");
    if (connectivity == u"none") return tr("no internet");
    return tr("unknown");
}

QString SystemModel::networkDetail() const
{
    if (!m_wifiSsid.isEmpty())
        return tr("Wi-Fi %1 · %2").arg(m_wifiSsid, connectivityLabel(m_connectivity));
    return tr("connectivity: %1").arg(connectivityLabel(m_connectivity));
}

QString SystemModel::memoryText() const
{
    return tr("%1 / %2 GB").arg(formatGb(m_memUsed), formatGb(m_memTotal));
}

double SystemModel::memoryFraction() const { return fraction(m_memUsed, m_memTotal); }

QString SystemModel::diskText() const
{
    return tr("%1 / %2 GB").arg(formatGb(m_diskUsed), formatGb(m_diskSize));
}

double SystemModel::diskFraction() const { return fraction(m_diskUsed, m_diskSize); }

QString SystemModel::modelDetail() const
{
    if (!hasModel())
        return {};
    return u"%1 · %2"_s.arg(m_modelLocal ? tr("On your machines") : tr("In the cloud"),
                            m_modelTools ? tr("can control the OS") : tr("can chat, can't control the OS"));
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
    QString text = m_updatesCount == 1 ? tr("1 update") : tr("%n updates", nullptr, m_updatesCount);
    if (m_updatesSecurity > 0)
        text += tr(" · %n security", nullptr, m_updatesSecurity);
    return text;
}

QString SystemModel::modelDownloadText() const
{
    if (m_downloadState == u"downloading")
        return tr("Downloading · %1%").arg(m_downloadPercent);
    if (m_downloadState == u"pending")
        return tr("Waiting for the network to download");
    if (m_downloadState == u"failed")
        return tr("Download failed. It will try again.");
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
