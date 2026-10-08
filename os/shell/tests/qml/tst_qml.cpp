#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "app/AppFont.h"
#include "app/ShellController.h"
#include "control/ControlClient.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        applyShellFont();
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
        engine->rootContext()->setContextProperty(QStringLiteral("testShell"), shell);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_shell_qml, Setup)

#include "tst_qml.moc"
