#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "FakeAuthenticator.h"
#include "Language.h"
#include "model/CurrentUser.h"
#include "model/LockModel.h"

Q_IMPORT_QML_PLUGIN(JarvisLockPlugin)

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR);
    }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        auto* auth = new FakeAuthenticator(engine);
        auto* lock = new LockModel(auth, CurrentUser{QStringLiteral("muhammad"), QStringLiteral("Muhammad AbdElHay")}, engine);
        auto* language = new jarvis::ui::LanguageManager({QStringLiteral("jarvis-ui"), QStringLiteral("jarvis-lock")}, engine);
        QObject::connect(language, &jarvis::ui::LanguageManager::languageChanged, engine, &QQmlEngine::retranslate);
        QObject::connect(language, &jarvis::ui::LanguageManager::languageChanged, lock, &LockModel::retranslate);
        engine->rootContext()->setContextProperty(QStringLiteral("testLanguage"), language);
        engine->rootContext()->setContextProperty(QStringLiteral("testAuth"), auth);
        engine->rootContext()->setContextProperty(QStringLiteral("testLock"), lock);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_lock_qml, Setup)
#include "tst_qml.moc"
