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
        qputenv("JARVIS_I18N_DIR", QByteArrayLiteral(JARVIS_TEST_I18N_DIR));
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        jarvis::ui::applyJarvisFont();
        qputenv("JARVIS_OS_RELEASE", QByteArrayLiteral(JARVIS_TEST_OS_RELEASE)); // Brand.distroName = "Rafiq"
    }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        auto* language = new jarvis::ui::LanguageManager({QStringLiteral("jarvis-ui"), QStringLiteral("jarvis-installer")}, engine);
        QObject::connect(language, &jarvis::ui::LanguageManager::languageChanged, engine, &QQmlEngine::retranslate);
        auto* harness = new TestHarness(engine);
        harness->setLanguageManager(language);
        engine->rootContext()->setContextProperty(QStringLiteral("harness"), harness);
        engine->rootContext()->setContextProperty(QStringLiteral("testLanguage"), language);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_installer_qml, Setup)

#include "tst_qml.moc"
