#pragma once

#include "Language.h"
#include <QObject>
#include <QStringList>
#include <QVariantMap>

class FakeInstallerBackend;
class FakePower;
class InstallerModel;

// Gives QML tests a fresh InstallerModel on a scripted fake backend.
class TestHarness : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString screenshotDir READ screenshotDir CONSTANT)
public:
    explicit TestHarness(QObject* parent = nullptr);

    void setLanguageManager(jarvis::ui::LanguageManager* language) { m_language = language; }

    Q_INVOKABLE InstallerModel* fresh(const QVariantMap& options = {});
    Q_INVOKABLE QStringList calls() const;
    Q_INVOKABLE QVariantMap lastChoices() const;
    Q_INVOKABLE QStringList executedPlanIds() const;
    Q_INVOKABLE QStringList powerCalls() const;
    Q_INVOKABLE void refuseNext(const QString& key, const QString& message);
    Q_INVOKABLE void setSummary(const QStringList& lines);
    Q_INVOKABLE void progress(const QString& stepId, int percent, const QString& detail);
    Q_INVOKABLE void modelProgress(int percent, const QString& detail);
    Q_INVOKABLE void finish(bool ok, const QString& errorStep, const QString& message);
    QString screenshotDir() const { return qEnvironmentVariable("JARVIS_SCREENSHOT_DIR"); }

private:
    jarvis::ui::LanguageManager* m_language = nullptr;
    FakeInstallerBackend* m_backend = nullptr;
    FakePower* m_power = nullptr;
    InstallerModel* m_model = nullptr;
};
