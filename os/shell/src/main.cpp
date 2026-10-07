#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QtQml/qqmlextensionplugin.h>

#include "app/AppFont.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);
    QQuickStyle::setStyle(QStringLiteral("Basic"));
    applyShellFont();
    QQmlApplicationEngine engine;
    engine.loadFromModule("Jarvis.Shell", "Main");
    return engine.rootObjects().isEmpty() ? 1 : app.exec();
}
