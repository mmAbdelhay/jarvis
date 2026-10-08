#pragma once

#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QVariantList>
#include <QtQml/qqmlregistration.h>
#include <optional>

#include "InstallRules.h"

// Disk step (design: "Where should Rafiq go?"): which disk, alongside Windows /
// erase / manual, the alongside size, encryption, and the manual table.
// It only builds Choices.disk; the backend's Plan decides what really happens.
class DiskChoice : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Owned by InstallerModel")
    Q_PROPERTY(QVariantList disks READ disks NOTIFY changed)
    Q_PROPERTY(QString diskPath READ diskPath WRITE setDiskPath NOTIFY changed)
    Q_PROPERTY(QString description READ description NOTIFY changed)
    Q_PROPERTY(QVariantList options READ options NOTIFY changed)
    Q_PROPERTY(QString mode READ mode WRITE setMode NOTIFY changed)
    Q_PROPERTY(bool encrypt READ encrypt WRITE setEncrypt NOTIFY changed)
    Q_PROPERTY(double alongsideBytes READ alongsideBytes WRITE setAlongsideBytes NOTIFY changed)
    Q_PROPERTY(double alongsideMinBytes READ alongsideMinBytes NOTIFY changed)
    Q_PROPERTY(double alongsideMaxBytes READ alongsideMaxBytes NOTIFY changed)
    Q_PROPERTY(QString alongsideText READ alongsideText NOTIFY changed)
    Q_PROPERTY(bool barVisible READ barVisible NOTIFY changed)
    Q_PROPERTY(double otherFraction READ otherFraction NOTIFY changed)
    Q_PROPERTY(QString otherLabel READ otherLabel CONSTANT)
    Q_PROPERTY(QString ourLabel READ ourLabel CONSTANT)
    Q_PROPERTY(QVariantList manualRows READ manualRows NOTIFY changed)
    Q_PROPERTY(QStringList mountPoints READ mountPoints CONSTANT)
    Q_PROPERTY(bool valid READ valid NOTIFY changed)
    Q_PROPERTY(QString blockText READ blockText NOTIFY changed)

public:
    explicit DiskChoice(const QString& distro, QObject* parent = nullptr);

    void applyProbe(const QJsonObject& probe);

    QVariantList disks() const;
    QString diskPath() const { return m_diskPath; }
    void setDiskPath(const QString& path);
    QString description() const;
    QVariantList options() const;
    QString mode() const { return m_mode; }
    void setMode(const QString& mode);
    bool encrypt() const { return m_encrypt; }
    void setEncrypt(bool encrypt);
    double alongsideBytes() const { return double(m_alongside); }
    void setAlongsideBytes(double bytes);
    double alongsideMinBytes() const { return double(minAlongside()); }
    double alongsideMaxBytes() const;
    QString alongsideText() const;
    bool barVisible() const { return m_mode == u"alongside" || m_mode == u"erase"; }
    double otherFraction() const;
    QString otherLabel() const { return QStringLiteral("Windows"); }
    QString ourLabel() const { return m_distro; }
    QVariantList manualRows() const;
    QStringList mountPoints() const;
    bool valid() const;
    QString blockText() const;

    Q_INVOKABLE void setManualMount(const QString& partition, const QString& mount);
    Q_INVOKABLE void setManualFormat(const QString& partition, bool format);
    qint64 targetBytes() const;
    QJsonObject toJson() const;

signals:
    void changed();

private:
    struct ManualRow {
        QString path, fs, label;
        qint64 sizeBytes = 0;
        QString mount;
        bool format = false;
    };
    QJsonObject currentDisk() const;
    qint64 diskSize() const { return currentDisk().value("sizeBytes").toInteger(); }
    qint64 minAlongside() const;
    void resetForDisk();
    QString optionReason(const QString& id) const;
    QString manualProblem() const;

    QString m_distro;
    QJsonArray m_disks;
    QString m_diskPath;
    QString m_mode;
    bool m_encrypt = true;
    qint64 m_alongside = 0;
    std::optional<jarvis::installer::WindowsPartition> m_windows;
    QList<ManualRow> m_manual;
    qint64 m_minRoot = jarvis::installer::kMinSystemBytes; // ProbeResult.minRootBytes (contracts §10)
};
