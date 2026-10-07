#include "DiskChoice.h"

#include <QVariantMap>
#include <algorithm>
#include <cmath>

using namespace Qt::StringLiterals;
using namespace jarvis::installer;

DiskChoice::DiskChoice(const QString& distro, QObject* parent)
    : QObject(parent)
    , m_distro(distro)
{
}

qint64 DiskChoice::minAlongside() const
{
    const qint64 minimum = std::max(m_minRoot, currentDisk().value("alongsideBounds").toObject().value("minBytes").toInteger());
    return ((minimum + GB - 1) / GB) * GB; // minRootBytes rounded up to whole GB
}

QJsonObject DiskChoice::currentDisk() const
{
    for (const QJsonValue& d : m_disks)
        if (d.toObject().value("path").toString() == m_diskPath)
            return d.toObject();
    return {};
}

void DiskChoice::applyProbe(const QJsonObject& probe)
{
    // Contracts §10: the live medium is never offered; minRootBytes replaces the UI's 30 GiB guess.
    const QString live = probe.value("liveDevice").toString();
    m_disks = {};
    for (const QJsonValue& d : probe.value("disks").toArray())
        if (live.isEmpty() || d.toObject().value("path").toString() != live)
            m_disks.append(d);
    const qint64 minRoot = probe.value("minRootBytes").toInteger();
    m_minRoot = minRoot > 0 ? minRoot : kMinSystemBytes;
    m_diskPath.clear();
    for (const QJsonValue& d : std::as_const(m_disks))
        if (!d.toObject().value("removable").toBool()) {
            m_diskPath = d.toObject().value("path").toString();
            break;
        }
    if (m_diskPath.isEmpty() && !m_disks.isEmpty())
        m_diskPath = m_disks.at(0).toObject().value("path").toString();
    resetForDisk();
    emit changed();
}

void DiskChoice::resetForDisk()
{
    const QJsonObject disk = currentDisk();
    m_windows = windowsPartition(disk);
    m_manual.clear();
    for (const QJsonValue& value : disk.value("partitions").toArray()) {
        const QJsonObject p = value.toObject();
        m_manual.append({p.value("path").toString(), p.value("fs").toString(), p.value("label").toString(),
                         p.value("sizeBytes").toInteger(), QString(), false});
    }
    m_alongside = 0;
    if (m_windows) {
        const qint64 half = ((m_windows->sizeBytes - m_windows->minSizeBytes) / 2 / GB) * GB;
        m_alongside = std::clamp(half, minAlongside(), std::max(minAlongside(), jarvis::installer::alongsideMaxBytes(*m_windows)));
    }
    if (m_windows && optionReason(u"alongside"_s).isEmpty())
        m_mode = u"alongside"_s;
    else if (!m_windows && optionReason(u"erase"_s).isEmpty())
        m_mode = u"erase"_s;
    else
        m_mode.clear(); // Windows is here but can't be shrunk: never default to erasing it
}

QVariantList DiskChoice::disks() const
{
    QVariantList fixed, removable;
    for (const QJsonValue& value : m_disks) {
        const QJsonObject d = value.toObject();
        const bool isRemovable = d.value("removable").toBool();
        QString text = u"%1 · %2"_s.arg(d.value("model").toString(), formatSize(d.value("sizeBytes").toInteger()));
        if (isRemovable)
            text += u" · removable"_s;
        (isRemovable ? removable : fixed).append(QVariantMap{{u"value"_s, d.value("path").toString()}, {u"text"_s, text}});
    }
    return fixed + removable;
}

void DiskChoice::setDiskPath(const QString& path)
{
    if (path == m_diskPath)
        return;
    const bool known = std::any_of(m_disks.cbegin(), m_disks.cend(),
                                   [&](const QJsonValue& d) { return d.toObject().value("path").toString() == path; });
    if (!known)
        return;
    m_diskPath = path;
    resetForDisk();
    emit changed();
}

QString DiskChoice::description() const
{
    const QJsonObject disk = currentDisk();
    if (disk.isEmpty())
        return {};
    QString text = u"%1 · %2"_s.arg(disk.value("model").toString(), formatSize(disk.value("sizeBytes").toInteger()));
    if (m_windows)
        text += u" · contains Windows on %1 (%2 used)"_s.arg(m_windows->path, formatSize(m_windows->usedBytes));
    return text;
}

QString DiskChoice::optionReason(const QString& id) const
{
    if (id == u"alongside") {
        if (!m_windows || currentDisk().value("alongsideBounds").isNull() || currentDisk().value("alongsideBounds").toObject().isEmpty())
            return refusalText(u"alongside-no-windows"_s, {}, m_distro);
        const QString key = alongsideRefusalKey(*m_windows, minAlongside());
        return key.isEmpty() ? QString() : refusalText(key, {}, m_distro);
    }
    if (id == u"erase" && diskSize() < m_minRoot)
        return refusalText(u"disk-too-small"_s, {}, m_distro);
    return {};
}

QVariantList DiskChoice::options() const
{
    auto make = [this](const QString& id, const QString& title, const QString& detail) {
        const QString reason = optionReason(id);
        return QVariantMap{{u"id"_s, id}, {u"title"_s, title}, {u"detail"_s, reason.isEmpty() ? detail : reason},
                           {u"enabled"_s, reason.isEmpty()}, {u"reason"_s, reason}};
    };
    QVariantList out;
    if (m_windows)
        out.append(make(u"alongside"_s, u"Install alongside Windows"_s,
                        u"Give %1 %2. Choose which system to start each time you boot."_s.arg(m_distro, formatSize(m_alongside))));
    out.append(make(u"erase"_s, u"Erase the whole disk"_s,
                    m_windows ? u"Deletes Windows and every file on this disk."_s : u"Deletes every file on this disk."_s));
    out.append(make(u"manual"_s, u"Manual partitioning"_s, u"For people who know exactly what they want."_s));
    return out;
}

void DiskChoice::setMode(const QString& mode)
{
    if (mode != u"erase" && mode != u"alongside" && mode != u"manual")
        return;
    if ((mode == u"alongside" && !m_windows) || !optionReason(mode).isEmpty() || mode == m_mode)
        return;
    m_mode = mode;
    emit changed();
}

void DiskChoice::setEncrypt(bool encrypt)
{
    if (encrypt == m_encrypt)
        return;
    m_encrypt = encrypt;
    emit changed();
}

double DiskChoice::alongsideMaxBytes() const
{
    return m_windows ? double(std::max(minAlongside(), (jarvis::installer::alongsideMaxBytes(*m_windows) / GB) * GB)) : 0.0;
}

void DiskChoice::setAlongsideBytes(double bytes)
{
    if (!m_windows || !std::isfinite(bytes) || !optionReason(u"alongside"_s).isEmpty())
        return;
    bytes = std::clamp(bytes, alongsideMinBytes(), alongsideMaxBytes());
    const qint64 snapped = std::clamp(qint64(qRound64(bytes / double(GB))) * GB, minAlongside(), qint64(alongsideMaxBytes()));
    if (snapped == m_alongside)
        return;
    m_alongside = snapped;
    emit changed();
}

QString DiskChoice::alongsideText() const
{
    if (!m_windows)
        return {};
    return u"Give %1 %2. Windows keeps %3."_s.arg(m_distro, formatSize(m_alongside),
                                                  formatSize(m_windows->sizeBytes - m_alongside));
}

double DiskChoice::otherFraction() const
{
    const qint64 size = diskSize();
    if (m_mode != u"alongside" || size <= 0)
        return 0.0;
    return std::clamp(double(size - m_alongside) / double(size), 0.0, 1.0);
}

QVariantList DiskChoice::manualRows() const
{
    QVariantList out;
    for (const ManualRow& r : m_manual)
        out.append(QVariantMap{{u"path"_s, r.path}, {u"fs"_s, r.fs}, {u"label"_s, r.label},
                               {u"sizeText"_s, formatSize(r.sizeBytes)}, {u"mount"_s, r.mount}, {u"format"_s, r.format}});
    return out;
}

QStringList DiskChoice::mountPoints() const
{
    return {QString(), u"/"_s, u"/boot/efi"_s, u"swap"_s};
}

void DiskChoice::setManualMount(const QString& partition, const QString& mount)
{
    if (!mountPoints().contains(mount))
        return;
    auto row = std::find_if(m_manual.begin(), m_manual.end(), [&](const ManualRow& r) { return r.path == partition; });
    if (row == m_manual.end())
        return;
    if (!mount.isEmpty())
        for (ManualRow& other : m_manual)
            if (other.mount == mount) {
                other.mount.clear();
                other.format = false;
            }
    row->mount = mount;
    row->format = mount == u"/" || mount == u"swap";
    emit changed();
}

void DiskChoice::setManualFormat(const QString& partition, bool format)
{
    auto row = std::find_if(m_manual.begin(), m_manual.end(), [&](const ManualRow& r) { return r.path == partition; });
    if (row == m_manual.end() || row->mount.isEmpty() || (row->mount == u"/" && !format) || row->format == format)
        return;
    row->format = format;
    emit changed();
}

QString DiskChoice::manualProblem() const
{
    auto has = [this](const QString& mount) {
        return std::any_of(m_manual.cbegin(), m_manual.cend(), [&](const ManualRow& r) { return r.mount == mount; });
    };
    if (!has(u"/"_s))
        return refusalText(u"manual-missing-root"_s, {}, m_distro);
    if (!has(u"/boot/efi"_s))
        return refusalText(u"manual-missing-esp"_s, {}, m_distro);
    for (const ManualRow& row : m_manual) {
        if (row.mount == u"/" && !row.format)
            return u"The system partition must be formatted."_s;
        if (row.mount == u"/boot/efi" && (row.path != currentDisk().value("esp").toString() || row.sizeBytes < 300000000))
            return u"Choose an existing EFI system partition of at least 300 MB."_s;
        if (row.mount == u"swap" && m_encrypt)
            return u"Encrypted installs use a swapfile instead of a swap partition."_s;
    }
    return {};
}

bool DiskChoice::valid() const
{
    return blockText().isEmpty();
}

QString DiskChoice::blockText() const
{
    if (m_diskPath.isEmpty())
        return u"No disk was found to install %1 on."_s.arg(m_distro);
    if (m_mode.isEmpty())
        return m_windows ? u"Choose how to install %1: next to Windows, or on the whole disk."_s.arg(m_distro)
                         : u"Choose where to install %1."_s.arg(m_distro);
    if (const QString reason = optionReason(m_mode); !reason.isEmpty())
        return reason;
    if (m_mode == u"manual")
        return manualProblem();
    return {};
}

qint64 DiskChoice::targetBytes() const
{
    if (m_mode == u"alongside")
        return m_alongside;
    if (m_mode == u"erase")
        return diskSize();
    if (m_mode == u"manual")
        for (const ManualRow& r : m_manual)
            if (r.mount == u"/")
                return r.sizeBytes;
    return 0;
}

QJsonObject DiskChoice::toJson() const
{
    QJsonObject out{{"path", m_diskPath}, {"mode", m_mode}};
    if (m_mode == u"alongside")
        out.insert("alongsideSizeBytes", double(m_alongside));
    if (m_mode == u"manual") {
        QJsonArray rows;
        for (const ManualRow& r : m_manual)
            if (!r.mount.isEmpty())
                rows.append(QJsonObject{{"partition", r.path}, {"mount", r.mount}, {"format", r.format}});
        out.insert("manual", rows);
    }
    return out;
}
