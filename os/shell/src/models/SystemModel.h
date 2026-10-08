#pragma once

#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QtQml/qqmlregistration.h>

// "This machine" facts from the sys:snapshot push (contracts §6.8: every 10 s
// and on change, re-pushed on every new control connection). `online` also
// gates the Network doctor offer (ShellController::offerDoctor).
class SystemModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool known READ known NOTIFY changed)
    Q_PROPERTY(bool online READ online NOTIFY changed)
    Q_PROPERTY(QString connectivity READ connectivity NOTIFY changed)
    Q_PROPERTY(QString wifiSsid READ wifiSsid NOTIFY changed)
    Q_PROPERTY(QString networkText READ networkText NOTIFY changed)
    Q_PROPERTY(QString networkDetail READ networkDetail NOTIFY changed)
    Q_PROPERTY(QString memoryText READ memoryText NOTIFY changed)
    Q_PROPERTY(double memoryFraction READ memoryFraction NOTIFY changed)
    Q_PROPERTY(QString diskText READ diskText NOTIFY changed)
    Q_PROPERTY(double diskFraction READ diskFraction NOTIFY changed)
    Q_PROPERTY(QStringList failedUnits READ failedUnits NOTIFY changed)
    Q_PROPERTY(bool hasModel READ hasModel NOTIFY changed)
    Q_PROPERTY(QString modelName READ modelName NOTIFY changed)
    Q_PROPERTY(QString modelDetail READ modelDetail NOTIFY changed)
    Q_PROPERTY(int updatesCount READ updatesCount NOTIFY changed)
    Q_PROPERTY(int updatesSecurity READ updatesSecurity NOTIFY changed)
    Q_PROPERTY(QString updatesText READ updatesText NOTIFY changed)
    Q_PROPERTY(QString modelDownloadState READ modelDownloadState NOTIFY changed)
    Q_PROPERTY(int modelDownloadPercent READ modelDownloadPercent NOTIFY changed)
    Q_PROPERTY(QString modelDownloadText READ modelDownloadText NOTIFY changed)

public:
    explicit SystemModel(QObject* parent = nullptr);

    bool known() const { return m_known; }
    bool online() const { return m_online; }
    QString connectivity() const { return m_connectivity; }
    QString wifiSsid() const { return m_wifiSsid; }
    QString networkText() const;
    QString networkDetail() const;
    QString memoryText() const;
    double memoryFraction() const;
    QString diskText() const;
    double diskFraction() const;
    QStringList failedUnits() const { return m_failedUnits; }
    bool hasModel() const { return !m_modelName.isEmpty(); }
    QString modelName() const { return m_modelName; }
    QString modelDetail() const;
    // M2 contracts §2 sys:snapshot.updates and §5 sys:snapshot.model.download.
    int updatesCount() const { return m_updatesCount; }
    int updatesSecurity() const { return m_updatesSecurity; }
    QString updatesText() const;
    QString modelDownloadState() const { return m_downloadState; }
    int modelDownloadPercent() const { return m_downloadPercent; }
    QString modelDownloadText() const;
    Q_INVOKABLE void applyUpdateCounts(int count, int security);

    Q_INVOKABLE void applySnapshot(const QJsonObject& snapshot);
    Q_INVOKABLE void reset();

    static QString formatGb(double bytes);

signals:
    void changed();

private:
    bool m_known = false;
    bool m_online = true;
    QString m_connectivity;
    QString m_wifiSsid;
    double m_memTotal = 0, m_memUsed = 0, m_diskSize = 0, m_diskUsed = 0;
    QStringList m_failedUnits;
    QString m_modelName;
    bool m_modelLocal = false;
    bool m_modelTools = false;
    void setUpdateCounts(int count, int security);
    int m_updatesCount = 0;
    int m_updatesSecurity = 0;
    QString m_downloadState;
    int m_downloadPercent = 0;
};
