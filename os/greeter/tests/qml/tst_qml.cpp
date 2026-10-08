#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "GreeterHarness.h"
#include "JarvisFont.h"

Q_IMPORT_QML_PLUGIN(JarvisGreeterPlugin)

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        jarvis::ui::applyJarvisFont();
    }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        engine->rootContext()->setContextProperty(QStringLiteral("harness"), new GreeterHarness(engine));
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_greeter_qml, Setup)

#include "tst_qml.moc"
