#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQuickTest>

#include "Language.h"

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        qputenv("JARVIS_OS_RELEASE", QByteArrayLiteral(JARVIS_TEST_OS_RELEASE));
        qputenv("JARVIS_BRAND_JSON", QByteArrayLiteral(JARVIS_TEST_BRAND_JSON));
        qputenv("JARVIS_I18N_DIR", QByteArrayLiteral(JARVIS_TEST_I18N_DIR));
    }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        // "jarvis-ui" is the catalog Task 4 adds; until then "demo" stands in.
        auto* manager = new jarvis::ui::LanguageManager({QStringLiteral("demo"), QStringLiteral("jarvis-ui")}, engine);
        QObject::connect(manager, &jarvis::ui::LanguageManager::languageChanged, engine, &QQmlEngine::retranslate);
        engine->rootContext()->setContextProperty(QStringLiteral("testLanguage"), manager);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_ui_qml, Setup)

#include "tst_ui.moc"
