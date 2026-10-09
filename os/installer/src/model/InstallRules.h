#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <optional>
#include <utility>

// Pure rules behind the installer screens. The backend's Plan is the final
// judge (it refuses with the contract keys); these only shape what the UI
// offers and say why in plain words.
namespace jarvis::installer {

inline constexpr qint64 GiB = 1024LL * 1024 * 1024;
inline constexpr qint64 GB = 1000LL * 1000 * 1000;
inline constexpr qint64 kMinSystemBytes = 30 * GiB;       // fallback when ProbeResult.minRootBytes is missing (contracts §10)
inline constexpr qint64 kSystemReserveBytes = 20 * GiB;   // kept free beside a local model
inline constexpr qint64 kWindowsHeadroomBytes = 10 * GiB; // left to Windows beyond ntfsresize's minimum
inline constexpr qint64 kSliderStepBytes = GB;
// Encrypted installs get a separate unencrypted /boot (M2 contracts §12):
// erase and alongside create one of kBootBytes; a manual one needs kBootMinBytes.
inline constexpr qint64 kBootBytes = GiB;
inline constexpr qint64 kBootMinBytes = 500 * 1000 * 1000;

QString formatSize(qint64 bytes);

QString deriveUsername(const QString& fullName);
QString deriveHostname(const QString& username);
QString usernameProblem(const QString& username);
QString hostnameProblem(const QString& hostname);

enum class Strength { Empty, Weak, Fair, Strong };
Strength passwordStrength(const QString& password);
QString passwordStatus(const QString& password, const QString& confirm);
bool passwordAcceptable(const QString& password, const QString& confirm);

struct WindowsPartition {
    QString path;
    qint64 sizeBytes = 0;
    qint64 usedBytes = 0;
    qint64 minSizeBytes = 0;
    bool dirty = false;
    bool hibernated = false;
    bool bitlocker = false;
    // Backend alongsideBounds.maxBytes; absent bounds disable alongside.
    std::optional<qint64> maxAlongsideBytes;
};
std::optional<WindowsPartition> windowsPartition(const QJsonObject& disk);
qint64 alongsideMaxBytes(const WindowsPartition& windows);
QString alongsideRefusalKey(const WindowsPartition& windows, qint64 minRootBytes = kMinSystemBytes);

QJsonArray modelsThatFit(const QJsonObject& probe, qint64 targetBytes);

QStringList refusalKeys();
std::pair<QString, QString> splitRefusal(const QString& message);
QString refusalText(const QString& key, const QString& backendText, const QString& distro);

} // namespace jarvis::installer
