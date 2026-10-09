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
        qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR);
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        jarvis::ui::applyJarvisFont();
    }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        auto* manager = new jarvis::ui::LanguageManager({QStringLiteral("jarvis-ui"), QStringLiteral("jarvis-greeter")}, engine);
        QObject::connect(manager, &jarvis::ui::LanguageManager::languageChanged, engine, &QQmlEngine::retranslate);
        auto* harness = new GreeterHarness(engine);
        harness->setLanguageManager(manager);
        engine->rootContext()->setContextProperty(QStringLiteral("harness"), harness);
        engine->rootContext()->setContextProperty(QStringLiteral("testLanguage"), manager);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_greeter_qml, Setup)

#include "tst_qml.moc"
