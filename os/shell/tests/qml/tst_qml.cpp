#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QStandardPaths>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "Language.h"
#include "app/AppFont.h"
#include "app/ShellController.h"
#include "control/ControlClient.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
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
        engine->rootContext()->setContextProperty(QStringLiteral("testShell"), shell);
        // Separate controller for Settings connection lifecycle tests, so the
        // other views retain their never-connected controller.
        auto* settingsClient = new ControlClient(options, engine);
        auto* settingsShell = new ShellController(settingsClient, engine);
        engine->rootContext()->setContextProperty(QStringLiteral("testSettingsClient"), settingsClient);
        engine->rootContext()->setContextProperty(QStringLiteral("testSettingsShell"), settingsShell);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_shell_qml, Setup)

#include "tst_qml.moc"
