#include <QCommandLineParser>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTimer>
#include <QtQml/qqmlextensionplugin.h>
#include <cstdio>

#include "AppsModel.h"
#include "ClassicController.h"
#include "DesktopEntry.h"
#include "Language.h"
#include "Launcher.h"
#include "app/AppFont.h"
#include "app/ShellController.h"
#include "app/SingleInstance.h"
#include "control/ControlClient.h"
#include "protocol/BuildId.h"
#include "protocol/ControlPaths.h"
#include "surface/ClassicSurfaces.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)
Q_IMPORT_QML_PLUGIN(JarvisClassicPlugin)

using namespace Qt::StringLiterals;

namespace {
void say(const char* line)
{
    std::fputs(line, stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}
QQuickWindow* load(QQmlApplicationEngine& engine, const char* type)
{
    const qsizetype before = engine.rootObjects().size();
    engine.loadFromModule("Jarvis.Classic", type);
    return engine.rootObjects().size() > before ? qobject_cast<QQuickWindow*>(engine.rootObjects().constLast()) : nullptr;
}
} // namespace

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(u"jarvis-classic"_s);
    QGuiApplication::setApplicationVersion(QStringLiteral(JARVIS_CLASSIC_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(u"The Rafiq classic desktop: taskbar, Apps menu and a docked Jarvis panel."_s);
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption chatOption(u"chat"_s, u"Open the docked Jarvis panel."_s);
    const QCommandLineOption windowedOption(u"windowed"_s, u"Ordinary windows instead of layer-shell surfaces."_s);
    const QCommandLineOption quitAfterOption(u"quit-after"_s, u"Quit after <ms> (smoke tests)."_s, u"ms"_s);
    parser.addOptions({chatOption, windowedOption, quitAfterOption});
    parser.process(app);

    SingleInstance instance(SingleInstance::nameFor(u"jarvis-classic"_s));
    if (instance.forward(parser.isSet(chatOption) ? "chat" : "focus"))
        return 0;
    instance.listen();

    QQuickStyle::setStyle(u"Basic"_s);
    applyShellFont();
    jarvis::ui::LanguageManager language({u"jarvis-ui"_s, u"jarvis-shell"_s, u"jarvis-classic"_s});
    language.setLanguage(jarvis::ui::languageFromEnvironment());

    const auto paths = jarvis::protocol::controlPaths(jarvis::protocol::defaultRunDirectory());
    ControlOptions options;
    options.socketPath = paths.socketPath;
    options.secretPath = paths.secretPath;
    options.build = jarvis::protocol::readBuildId(jarvis::protocol::defaultBuildStampPath());
    ControlClient client(options);
    ShellController shell(&client);
    shell.setLanguageApplier([&language](const QString& code) { return language.setLanguage(code); }, language.language());

    AppsModel apps(jarvis::ui::applicationDirectories(), AppsModel::currentDesktops());
    Launcher launcher;
    ClassicController controller(&apps, &launcher, ClassicController::fallbackActive(ClassicController::defaultMarkerPath()));
    controller.setShell(&shell);

    QQmlApplicationEngine engine;
    QObject::connect(&language, &jarvis::ui::LanguageManager::languageChanged, &engine, &QQmlEngine::retranslate);
    QObject::connect(&language, &jarvis::ui::LanguageManager::languageChanged, &apps, &AppsModel::retranslate);
    engine.setInitialProperties({{u"controller"_s, QVariant::fromValue(&controller)}});
    QQuickWindow* taskbar = load(engine, "TaskbarWindow");
    QQuickWindow* appsWindow = load(engine, "AppsWindow");
    QQuickWindow* chatWindow = load(engine, "ChatWindow");
    if (!taskbar || !appsWindow || !chatWindow)
        return 1;

    const bool layerShell = !parser.isSet(windowedOption) && QGuiApplication::platformName().startsWith(u"wayland"_s);
    ClassicSurfaces surfaces(taskbar, appsWindow, chatWindow, &controller, layerShell);
    QObject::connect(&surfaces, &ClassicSurfaces::taskbarShown, &app, [] { say("jarvis-classic: taskbar shown"); });
    QObject::connect(&surfaces, &ClassicSurfaces::chatShown, &app, [] { say("jarvis-classic: chat shown"); });
    QObject::connect(&instance, &SingleInstance::messageReceived, &controller, [&controller](const QByteArray&) {
        controller.openChat(); // Super (focus) and --chat both bring up the panel
    });

    surfaces.show();
    if (parser.isSet(chatOption))
        controller.openChat();
    if (parser.isSet(quitAfterOption))
        QTimer::singleShot(parser.value(quitAfterOption).toInt(), &app, &QCoreApplication::quit);
    client.start();
    return app.exec();
}
