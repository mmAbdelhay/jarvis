#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "JarvisFont.h"
#include "TestHarness.h"

Q_IMPORT_QML_PLUGIN(JarvisInstallerPlugin)

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        jarvis::ui::applyJarvisFont();
        qputenv("JARVIS_OS_RELEASE", QByteArrayLiteral(JARVIS_TEST_OS_RELEASE)); // Brand.distroName = "Rafiq"
    }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        engine->rootContext()->setContextProperty(QStringLiteral("harness"), new TestHarness(engine));
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_installer_qml, Setup)

#include "tst_qml.moc"
