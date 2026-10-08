#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "FakeAuthenticator.h"
#include "model/CurrentUser.h"
#include "model/LockModel.h"

Q_IMPORT_QML_PLUGIN(JarvisLockPlugin)

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable() { QQuickStyle::setStyle(QStringLiteral("Basic")); }
    void qmlEngineAvailable(QQmlEngine* engine)
    {
        engine->addImportPath(QStringLiteral(JARVIS_QML_DIR));
        auto* auth = new FakeAuthenticator(engine);
        auto* lock = new LockModel(auth, CurrentUser{QStringLiteral("muhammad"), QStringLiteral("Muhammad AbdElHay")}, engine);
        engine->rootContext()->setContextProperty(QStringLiteral("testAuth"), auth);
        engine->rootContext()->setContextProperty(QStringLiteral("testLock"), lock);
    }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_lock_qml, Setup)
#include "tst_qml.moc"
