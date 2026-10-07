#include <QQmlEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>
#include <QtQuickTest>

#include "app/AppFont.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

class Setup : public QObject {
    Q_OBJECT
public slots:
    void applicationAvailable()
    {
        QQuickStyle::setStyle(QStringLiteral("Basic"));
        applyShellFont();
    }
    void qmlEngineAvailable(QQmlEngine* engine) { Q_UNUSED(engine) }
};

QUICK_TEST_MAIN_WITH_SETUP(jarvis_shell_qml, Setup)

#include "tst_qml.moc"
