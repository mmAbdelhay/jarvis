#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QStandardPaths>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "Language.h"
#include "app/AppFont.h"
#include "app/AppIconProvider.h"
#include "app/ShellController.h"
#include "control/ControlClient.h"
#include "models/CuSessionModel.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

class Setup : public QObject {
    Q_OBJECT
    QList<QStringList> m_launched;
public slots:
    QStringList lastLaunch() const { return m_launched.isEmpty() ? QStringList{} : m_launched.last(); }
    int launchCount() const { return int(m_launched.size()); }
    void applyCuRequestResult(CuSessionModel* session, bool ok, const QString& text)
    {
        session->applyRequestResult(ok, text);
    }

    void applicationAvailable()
    {
        qputenv("XDG_DATA_DIRS", QByteArrayLiteral(JARVIS_SHELL_TEST_DATA "/xdg"));
        qputenv("XDG_DATA_HOME", QByteArrayLiteral(JARVIS_SHELL_TEST_DATA "/xdg-home-empty"));
        QStandardPaths::setTestModeEnabled(true);
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        applyShellFont();
        qputenv("JARVIS_I18N_DIR", QByteArrayLiteral(JARVIS_TEST_I18N_DIR));
    }

    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR)); // Jarvis.UI from this build
        // A controller whose client never connects: views can be driven
        // without a daemon. Launches are recorded, never executed.
        ControlOptions options;
        options.socketPath = QStringLiteral("/tmp/jsh-no-daemon/jarvisd.sock");
        options.secretPath = QStringLiteral("/tmp/jsh-no-daemon/control.secret");
        auto* client = new ControlClient(options, engine);
        auto* shell = new ShellController(client, engine);
        shell->setLauncher([](const QString&) { return true; });
        auto* language = new jarvis::ui::LanguageManager({QStringLiteral("jarvis-ui"), QStringLiteral("jarvis-shell")}, engine);
        QObject::connect(language, &jarvis::ui::LanguageManager::languageChanged, engine, &QQmlEngine::retranslate);
        shell->setLanguageApplier([language](const QString& code) { return language->setLanguage(code); }, language->language());
        engine->rootContext()->setContextProperty(QStringLiteral("testLanguage"), language);
        engine->rootContext()->setContextProperty(QStringLiteral("testCuRequests"), this);
        engine->rootContext()->setContextProperty(QStringLiteral("testShell"), shell);
        // Separate controller for Settings connection lifecycle tests, so the
        // other views retain their never-connected controller.
        auto* settingsClient = new ControlClient(options, engine);
        auto* settingsShell = new ShellController(settingsClient, engine);
        engine->rootContext()->setContextProperty(QStringLiteral("testSettingsClient"), settingsClient);
        engine->rootContext()->setContextProperty(QStringLiteral("testSettingsShell"), settingsShell);
        auto* appsShell = new ShellController(new ControlClient(options, engine), engine);
        appsShell->setAppStarter([this](const QString& program, const QStringList& args) {
            m_launched.append(QStringList{program} + args);
            return true;
        });
        engine->addImageProvider(QStringLiteral("appicon"), new AppIconProvider);
        QObject::connect(language, &jarvis::ui::LanguageManager::languageChanged, appsShell->apps(), &AppsModel::retranslate);
        engine->rootContext()->setContextProperty(QStringLiteral("testAppsShell"), appsShell);
        engine->rootContext()->setContextProperty(QStringLiteral("testApps"), this);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_shell_qml, Setup)

#include "tst_qml.moc"
