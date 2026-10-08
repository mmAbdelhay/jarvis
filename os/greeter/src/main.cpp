#include <QCommandLineParser>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTimer>
#include <QtQml/qqmlextensionplugin.h>

#include "FakePower.h"
#include "GreetdClient.h"
#include "JarvisFont.h"
#include "KeyboardLabel.h"
#include "LoginModel.h"
#include "ModelStatus.h"
#include "UserList.h"
#ifdef JARVIS_HAVE_DBUS
#include "LogindPower.h"
#endif

Q_IMPORT_QML_PLUGIN(JarvisGreeterPlugin)

using namespace Qt::StringLiterals;

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(u"jarvis-greeter"_s);
    QGuiApplication::setApplicationVersion(QStringLiteral(JARVIS_GREETER_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(u"The login screen, run by greetd under cage."_s);
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption windowed(u"windowed"_s, u"Run in a window (development)."_s);
    const QCommandLineOption socket(u"socket"_s, u"greetd socket (default: $GREETD_SOCK)."_s, u"path"_s);
    const QCommandLineOption quitAfter(u"quit-after"_s, u"Quit after this many milliseconds (smoke tests)."_s, u"ms"_s);
    parser.addOptions({windowed, socket, quitAfter});
    parser.process(app);

    QQuickStyle::setStyle(u"Basic"_s);
    jarvis::ui::applyJarvisFont();

    auto* client = new GreetdClient(parser.isSet(socket) ? parser.value(socket) : GreetdClient::socketPathFromEnvironment(), &app);
#ifdef JARVIS_HAVE_DBUS
    PowerActions* power = new LogindPower(QDBusConnection::systemBus(), &app);
#else
    PowerActions* power = new FakePower(&app);
#endif
    auto* login = new LoginModel(client, power, readUsers(), &app);
    auto* status = new ModelStatus(ModelStatus::defaultStatePath(), ModelStatus::defaultCatalogPath(), &app);
    // greetd starts the session once the greeter exits after start_session succeeded.
    QObject::connect(login, &LoginModel::sessionStarted, &app, [] { QCoreApplication::exit(0); });

    QQmlApplicationEngine engine;
    engine.setInitialProperties({{u"login"_s, QVariant::fromValue(login)},
                                 {u"modelStatus"_s, QVariant::fromValue(status)},
                                 {u"keyboardCode"_s, keyboardCode()},
                                 {u"keyboardName"_s, keyboardName()}});
    engine.loadFromModule("Jarvis.Greeter", "Main");
    auto* window = engine.rootObjects().isEmpty() ? nullptr : qobject_cast<QQuickWindow*>(engine.rootObjects().constFirst());
    if (!window)
        return 1;
    if (parser.isSet(windowed))
        window->show();
    else
        window->showFullScreen();
    if (parser.isSet(quitAfter))
        QTimer::singleShot(parser.value(quitAfter).toInt(), &app, &QCoreApplication::quit);
    return app.exec();
}
