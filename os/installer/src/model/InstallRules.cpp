#include "InstallRules.h"

#include <QCoreApplication>
#include <QLocale>
#include <QRegularExpression>
#include <QSet>
#include <algorithm>

using namespace Qt::StringLiterals;

namespace jarvis::installer {

QString formatSize(qint64 bytes)
{
    const qint64 b = std::max<qint64>(0, bytes);
    const double gb = double(b) / double(GB);
    if (gb >= 1000)
        return QCoreApplication::translate("InstallRules", "%1 TB").arg(QLocale::c().toString(gb / 1000, 'f', 1));
    if (gb >= 10)
        return QCoreApplication::translate("InstallRules", "%1 GB").arg(qRound64(gb));
    if (gb >= 1)
        return QCoreApplication::translate("InstallRules", "%1 GB").arg(QLocale::c().toString(gb, 'f', 1));
    return QCoreApplication::translate("InstallRules", "%1 MB").arg(qRound64(double(b) / 1e6));
}

QString deriveUsername(const QString& fullName)
{
    static const QRegularExpression spaces(u"\\s+"_s);
    const QString first = fullName.trimmed().section(spaces, 0, 0);
    QString out;
    for (const QChar c : first.normalized(QString::NormalizationForm_KD)) {
        if (c.unicode() >= 128)
            continue; // drops accents (é → e + mark) and non-Latin scripts
        const QChar l = c.toLower();
        if ((l >= u'a' && l <= u'z') || (l >= u'0' && l <= u'9') || l == u'_' || l == u'-')
            out.append(l);
    }
    while (!out.isEmpty() && !(out.front() >= u'a' && out.front() <= u'z'))
        out.remove(0, 1);
    return out.left(32);
}

QString deriveHostname(const QString& username)
{
    return username.isEmpty() ? QString() : username + u"-computer"_s;
}

QString usernameProblem(const QString& username)
{
    static const QRegularExpression valid(u"^[a-z][a-z0-9_-]{0,31}$"_s);
    static const QSet<QString> reserved{
        u"root"_s, u"daemon"_s, u"bin"_s, u"sys"_s, u"sync"_s, u"games"_s, u"man"_s, u"lp"_s, u"mail"_s,
        u"news"_s, u"uucp"_s, u"proxy"_s, u"www-data"_s, u"backup"_s, u"list"_s, u"irc"_s, u"nobody"_s,
        u"messagebus"_s, u"polkitd"_s, u"systemd-network"_s, u"systemd-resolve"_s, u"systemd-timesync"_s,
        u"ollama"_s, u"greeter"_s};
    if (username.isEmpty())
        return QCoreApplication::translate("InstallRules", "Choose a username.");
    if (!valid.match(username).hasMatch())
        return QCoreApplication::translate("InstallRules", "Use lowercase letters, digits, - and _, starting with a letter (32 at most).");
    if (reserved.contains(username))
        return QCoreApplication::translate("InstallRules", "That name is used by the system. Pick another.");
    return {};
}

QString hostnameProblem(const QString& hostname)
{
    static const QRegularExpression valid(u"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$"_s);
    if (hostname.isEmpty())
        return QCoreApplication::translate("InstallRules", "Choose a computer name.");
    if (!valid.match(hostname).hasMatch())
        return QCoreApplication::translate("InstallRules", "Use lowercase letters, digits and - (not first or last), 63 at most.");
    return {};
}

Strength passwordStrength(const QString& password)
{
    if (password.isEmpty())
        return Strength::Empty;
    if (password.size() < 8)
        return Strength::Weak;
    bool lower = false, upper = false, digit = false, other = false;
    for (const QChar c : password) {
        if (c.isLower()) lower = true;
        else if (c.isUpper()) upper = true;
        else if (c.isDigit()) digit = true;
        else other = true;
    }
    const int classes = int(lower) + int(upper) + int(digit) + int(other);
    if ((password.size() >= 12 && classes >= 2) || classes >= 3)
        return Strength::Strong;
    return Strength::Fair;
}

QString passwordStatus(const QString& password, const QString& confirm)
{
    if (password.isEmpty())
        return {};
    QStringList parts;
    switch (passwordStrength(password)) {
    case Strength::Weak: parts << QCoreApplication::translate("InstallRules", "Too short: use at least 8 characters"); break;
    case Strength::Fair: parts << QCoreApplication::translate("InstallRules", "Fair password"); break;
    case Strength::Strong: parts << QCoreApplication::translate("InstallRules", "Strong password"); break;
    case Strength::Empty: break;
    }
    if (!confirm.isEmpty())
        parts << (password == confirm ? QCoreApplication::translate("InstallRules", "passwords match") : QCoreApplication::translate("InstallRules", "passwords don't match"));
    return parts.join(u" · "_s);
}

bool passwordAcceptable(const QString& password, const QString& confirm)
{
    return passwordStrength(password) >= Strength::Fair && password == confirm;
}

std::optional<WindowsPartition> windowsPartition(const QJsonObject& disk)
{
    const QString selected = disk.value("windowsPartition").toString();
    if (selected.isEmpty())
        return std::nullopt;
    for (const QJsonValue& value : disk.value("partitions").toArray()) {
        const QJsonObject p = value.toObject();
        if (p.value("path").toString() != selected)
            continue;
        const QJsonObject ntfs = p.value("ntfs").toObject();
        WindowsPartition w{selected, p.value("sizeBytes").toInteger(),
                           p.value("usedBytes").toInteger(), ntfs.value("minSizeBytes").toInteger(),
                           ntfs.value("dirty").toBool(), ntfs.value("hibernated").toBool(),
                           ntfs.value("bitlocker").toBool(), std::nullopt};
        const QJsonValue maximum = disk.value("alongsideBounds").toObject().value("maxBytes");
        if (maximum.isDouble())
            w.maxAlongsideBytes = maximum.toInteger();
        return w;
    }
    return std::nullopt;
}

qint64 alongsideMaxBytes(const WindowsPartition& windows)
{
    return std::max<qint64>(0, windows.maxAlongsideBytes.value_or(0));
}

QString alongsideRefusalKey(const WindowsPartition& windows, qint64 minRootBytes)
{
    if (windows.bitlocker)
        return u"ntfs-bitlocker"_s;
    if (windows.hibernated)
        return u"ntfs-hibernated"_s;
    if (windows.dirty)
        return u"ntfs-dirty"_s;
    if (alongsideMaxBytes(windows) < minRootBytes)
        return u"alongside-too-small"_s;
    return {};
}

namespace {
int tierRank(const QString& tier)
{
    if (tier == u"gpu") return 4;
    if (tier == u"large") return 3;
    if (tier == u"medium") return 2;
    if (tier == u"small") return 1;
    return 0;
}
} // namespace

QJsonArray modelsThatFit(const QJsonObject& probe, qint64 targetBytes)
{
    QList<QJsonObject> fit;
    for (const QJsonValue& value : probe.value("catalog").toArray()) {
        const QJsonObject m = value.toObject();
        if (m.value("id").toString().isEmpty() || m.value("ollamaTag").toString().isEmpty())
            continue;
        const qint64 size = m.value("sizeBytes").toInteger();
        // Hardware eligibility is decided by the backend. Only target disk
        // capacity (including the UI system reserve) is filtered here.
        if (m.value("fits").toBool() && size > 0 &&
            targetBytes >= kSystemReserveBytes && size <= targetBytes - kSystemReserveBytes)
            fit.append(m);
    }
    std::stable_sort(fit.begin(), fit.end(), [](const QJsonObject& a, const QJsonObject& b) {
        const int ra = tierRank(a.value("tier").toString()), rb = tierRank(b.value("tier").toString());
        if (ra != rb)
            return ra > rb;
        return a.value("sizeBytes").toInteger() > b.value("sizeBytes").toInteger();
    });
    QJsonArray out;
    for (const QJsonObject& m : fit)
        out.append(m);
    return out;
}

QStringList refusalKeys()
{
    return {u"no-uefi"_s, u"disk-too-small"_s, u"ntfs-bitlocker"_s, u"ntfs-hibernated"_s, u"ntfs-dirty"_s,
            u"alongside-too-small"_s, u"manual-missing-root"_s, u"manual-missing-esp"_s, u"model-does-not-fit"_s,
            u"live-medium"_s, u"alongside-no-windows"_s};
}

std::pair<QString, QString> splitRefusal(const QString& message)
{
    static const QRegularExpression prefixed(u"^([a-z-]+):\\s*(.*)$"_s, QRegularExpression::DotMatchesEverythingOption);
    const QString trimmed = message.trimmed();
    const auto match = prefixed.match(trimmed);
    if (match.hasMatch() && refusalKeys().contains(match.captured(1)))
        return {match.captured(1), match.captured(2).trimmed()};
    return {QString(), trimmed};
}

QString refusalText(const QString& key, const QString& backendText, const QString& distro)
{
    if (key == u"no-uefi")
        return QCoreApplication::translate("InstallRules", "This computer started the USB stick in legacy BIOS mode. %1 needs UEFI. Turn on UEFI in the firmware settings, then start from the USB stick again.").arg(distro);
    if (key == u"disk-too-small")
        return QCoreApplication::translate("InstallRules", "This disk is too small for %1. Pick a bigger disk.").arg(distro);
    if (key == u"ntfs-bitlocker")
        return QCoreApplication::translate("InstallRules", "Windows on this disk is encrypted with BitLocker, so it can't be shrunk safely. Turn off BitLocker in Windows first, or erase the disk.");
    if (key == u"ntfs-hibernated")
        return QCoreApplication::translate("InstallRules", "Windows is hibernated (Fast Startup), so its disk can't be shrunk safely. Start Windows and shut it down fully: hold Shift + Shut down.");
    if (key == u"ntfs-dirty")
        return QCoreApplication::translate("InstallRules", "Windows didn't shut down cleanly, so its disk can't be shrunk safely. Start Windows and shut it down fully: hold Shift + Shut down.");
    if (key == u"alongside-too-small")
        return QCoreApplication::translate("InstallRules", "There isn't enough free space in Windows to fit %1 next to it. Free up space in Windows, or erase the disk.").arg(distro);
    if (key == u"alongside-no-windows")
        return QCoreApplication::translate("InstallRules", "Installing alongside Windows needs a GPT disk with a Windows partition. Pick another disk or erase this disk.");
    if (key == u"live-medium")
        return QCoreApplication::translate("InstallRules", "That is the USB stick the installer is running from. Pick another disk.");
    if (key == u"manual-missing-root")
        return QCoreApplication::translate("InstallRules", "Choose a partition for / (the system).");
    if (key == u"manual-missing-esp")
        return QCoreApplication::translate("InstallRules", "Choose an EFI system partition for /boot/efi.");
    if (key == u"model-does-not-fit")
        return QCoreApplication::translate("InstallRules", "The chosen model doesn't fit in the space for %1. Pick a smaller model or give %1 more space.").arg(distro);
    return backendText.isEmpty() ? QCoreApplication::translate("InstallRules", "The installer can't go ahead with these choices.") : backendText;
}

} // namespace jarvis::installer
