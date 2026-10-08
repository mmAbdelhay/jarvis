#pragma once

#include <QObject>
#include "GreeterLanguage.h"
#include "Language.h"
#include <QStringList>
#include <QTemporaryDir>
#include <QVariantMap>

class FakeGreetd;
class FakePower;
class GreetdClient;
class LoginModel;
class ModelStatus;

class GreeterHarness : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString screenshotDir READ screenshotDir CONSTANT)
public:
    explicit GreeterHarness(QObject* parent = nullptr);
    ~GreeterHarness() override;

    void setLanguageManager(jarvis::ui::LanguageManager* manager);
    Q_INVOKABLE GreeterLanguage* language() const { return m_language; }
    Q_INVOKABLE QString sessionsDir() const { return QStringLiteral(JARVIS_GREETER_TEST_DATA "/sessions"); }
    Q_INVOKABLE QVariantMap startRequest() const;
    Q_INVOKABLE LoginModel* fresh(const QVariantMap& options = {});
    Q_INVOKABLE ModelStatus* status(const QString& stateJson);
    Q_INVOKABLE QStringList requestTypes() const;
    Q_INVOKABLE QStringList powerCalls() const;
    Q_INVOKABLE void dropNextCreate();
    QString screenshotDir() const { return qEnvironmentVariable("JARVIS_SCREENSHOT_DIR"); }

private:
    GreeterLanguage* m_language = nullptr;
    QTemporaryDir m_dir;
    FakeGreetd* m_greetd = nullptr;
    FakePower* m_power = nullptr;
    GreetdClient* m_client = nullptr;
    LoginModel* m_login = nullptr;
    ModelStatus* m_status = nullptr;
};
