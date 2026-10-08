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
#include "GreeterLanguage.h"
#include "Language.h"
#include "DesktopEntry.h"
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
    const QCommandLineOption session(u"session"_s, u"Chosen session desktop file (default: Rafiq session)."_s, u"path"_s,
                                     u"/usr/share/wayland-sessions/rafiq.desktop"_s);
    parser.addOptions({windowed, socket, quitAfter, session});
    parser.process(app);

    QQuickStyle::setStyle(u"Basic"_s);
    jarvis::ui::applyJarvisFont();
    jarvis::ui::LanguageManager languageManager({u"jarvis-ui"_s, u"jarvis-greeter"_s});
    languageManager.setLanguage(GreeterLanguage::systemLanguage());
    auto* language = new GreeterLanguage([&languageManager](const QString& code) { return languageManager.setLanguage(code); },
                                         languageManager.language(), &app);

    auto* client = new GreetdClient(parser.isSet(socket) ? parser.value(socket) : GreetdClient::socketPathFromEnvironment(), &app);
#ifdef JARVIS_HAVE_DBUS
    PowerActions* power = new LogindPower(QDBusConnection::systemBus(), &app);
#else
    PowerActions* power = new FakePower(&app);
#endif
    auto* login = new LoginModel(client, power, readUsers(), &app);
    if (const auto entry = jarvis::ui::parseDesktopEntry(parser.value(session)))
        login->setSessionExec(entry->exec);
    auto* status = new ModelStatus(ModelStatus::defaultStatePath(), ModelStatus::defaultCatalogPath(), &app);
    // greetd starts the session once the greeter exits after start_session succeeded.
    QObject::connect(login, &LoginModel::sessionStarted, &app, [] { QCoreApplication::exit(0); });

    QQmlApplicationEngine engine;
    engine.setInitialProperties({{u"language"_s, QVariant::fromValue(language)},
                                 {u"login"_s, QVariant::fromValue(login)},
                                 {u"modelStatus"_s, QVariant::fromValue(status)},
                                 {u"keyboardCode"_s, keyboardCode()},
                                 {u"keyboardName"_s, keyboardName()}});
    engine.loadFromModule("Jarvis.Greeter", "Main");
    auto* window = engine.rootObjects().isEmpty() ? nullptr : qobject_cast<QQuickWindow*>(engine.rootObjects().constFirst());
    if (!window)
        return 1;
    QObject::connect(&languageManager, &jarvis::ui::LanguageManager::languageChanged, &app, [&engine, window, login, status] {
        engine.retranslate();
        login->retranslate();
        status->retranslate();
        window->setProperty("keyboardName", keyboardName());
    });
    if (parser.isSet(windowed))
        window->show();
    else
        window->showFullScreen();
    if (parser.isSet(quitAfter))
        QTimer::singleShot(parser.value(quitAfter).toInt(), &app, &QCoreApplication::quit);
    return app.exec();
}
