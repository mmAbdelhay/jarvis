#pragma once

#include <QJsonObject>
#include <QObject>
#include <QStringList>
#include <QVariantList>
#include <QtQml/qqmlregistration.h>

#include "AccountChoice.h"
#include "BrainChoice.h"
#include "DiskChoice.h"
#include "InstallProgress.h"
#include "LocaleChoice.h"

class InstallerBackend;
class PowerActions;

// The installer flow (design: Installer.dc.html, spec §5.1). Seven steps;
// Probe at start, Plan when leaving Brain, Execute only from Review's
// Install button with the last plan's id. Leaving Review drops the plan and
// calls nothing. Secrets leave only through Execute and are wiped once it
// is accepted.
class InstallerModel : public QObject {
    Q_OBJECT
    QML_ELEMENT
    QML_UNCREATABLE("Created by main()")
    Q_PROPERTY(int step READ step NOTIFY stepChanged)
    Q_PROPERTY(QStringList stepLabels READ stepLabels CONSTANT)
    Q_PROPERTY(QString distroName READ distroName CONSTANT)
    Q_PROPERTY(bool busy READ busy NOTIFY stateChanged)
    Q_PROPERTY(bool probed READ probed NOTIFY stateChanged)
    Q_PROPERTY(bool canContinue READ canContinue NOTIFY stateChanged)
    Q_PROPERTY(QString blockText READ blockText NOTIFY stateChanged)
    Q_PROPERTY(QString nextLabel READ nextLabel NOTIFY stateChanged)
    Q_PROPERTY(QString nextVariant READ nextVariant NOTIFY stateChanged)
    Q_PROPERTY(bool backVisible READ backVisible NOTIFY stateChanged)
    Q_PROPERTY(QString refusalText READ refusalText NOTIFY stateChanged)
    Q_PROPERTY(QString errorText READ errorText NOTIFY stateChanged)
    Q_PROPERTY(bool canRetryProbe READ canRetryProbe NOTIFY stateChanged)
    Q_PROPERTY(QStringList summary READ summary NOTIFY planChanged)
    Q_PROPERTY(QStringList warnings READ warnings NOTIFY planChanged)
    Q_PROPERTY(QVariantList diskAfter READ diskAfter NOTIFY planChanged)
    Q_PROPERTY(LocaleChoice* locale READ locale CONSTANT)
    Q_PROPERTY(DiskChoice* disk READ disk CONSTANT)
    Q_PROPERTY(AccountChoice* account READ account CONSTANT)
    Q_PROPERTY(BrainChoice* brain READ brain CONSTANT)
    Q_PROPERTY(InstallProgress* progress READ progress CONSTANT)

public:
    enum Step { Welcome = 0, Disk, Account, Brain, Review, Installing, Done };
    Q_ENUM(Step)

    InstallerModel(InstallerBackend* backend, PowerActions* power, const QString& distroName,
                   const QString& systemLocale, const QByteArray& systemTimezone, QObject* parent = nullptr);

    int step() const { return m_step; }
    QStringList stepLabels() const;
    QString distroName() const { return m_distro; }
    bool busy() const { return m_call != Call::None; }
    bool probed() const { return m_probed; }
    bool canContinue() const;
    QString blockText() const;
    QString nextLabel() const;
    QString nextVariant() const { return m_step == Review ? QStringLiteral("approve") : QStringLiteral("primary"); }
    bool backVisible() const { return !busy() && m_step >= Disk && m_step <= Review; }
    QString refusalText() const { return m_refusal; }
    QString errorText() const { return m_error; }
    bool canRetryProbe() const { return m_step == Welcome && !m_probed && !busy() && !m_error.isEmpty(); }
    QStringList summary() const { return m_summary; }
    QStringList warnings() const { return m_warnings; }
    QVariantList diskAfter() const { return m_diskAfter; }
    LocaleChoice* locale() const { return m_locale; }
    DiskChoice* disk() const { return m_disk; }
    AccountChoice* account() const { return m_account; }
    BrainChoice* brain() const { return m_brain; }
    InstallProgress* progress() const { return m_progress; }

    Q_INVOKABLE void start();
    Q_INVOKABLE void next();
    Q_INVOKABLE void back();
    Q_INVOKABLE void goTo(int step);

    QJsonObject choices() const; // contracts §1 Choices — never a secret
    QString planId() const { return m_planId; }

signals:
    void stepChanged();
    void stateChanged();
    void planChanged();

private:
    enum class Call { None, Probe, Plan, Execute };

    void setStep(int step);
    void clearNotices();
    void clearPlan();
    void onProbed(const QJsonObject& result);
    void onPlanned(const QJsonObject& plan);
    void onRefused(const QString& key, const QString& message);
    void onExecuteAccepted();
    void onCallFailed(const QString& method, const QString& message);

    InstallerBackend* m_backend;
    PowerActions* m_power;
    QString m_distro;
    LocaleChoice* m_locale;
    DiskChoice* m_disk;
    AccountChoice* m_account;
    BrainChoice* m_brain;
    InstallProgress* m_progress;

    int m_step = Welcome;
    Call m_call = Call::None;
    bool m_probed = false;
    bool m_uefi = false;
    bool m_executeSent = false;
    QString m_refusal, m_error;
    QString m_planId;
    QStringList m_summary, m_warnings;
    QVariantList m_diskAfter;
};
