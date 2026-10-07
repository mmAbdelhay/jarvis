#include <QCommandLineParser>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QtQml/qqmlextensionplugin.h>

#include "app/AppFont.h"
#include "app/ShellController.h"
#include "app/ShellSurface.h"
#include "app/SingleInstance.h"
#include "control/ControlClient.h"
#include "protocol/BuildId.h"
#include "protocol/ControlPaths.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

using namespace Qt::StringLiterals;

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(u"jarvis-shell"_s);
    QGuiApplication::setApplicationVersion(QStringLiteral(JARVIS_SHELL_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(u"The Jarvis OS shell."_s);
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption focusOption(u"focus"_s, u"Bring the shell to the front and focus the chat."_s);
    const QCommandLineOption windowedOption(u"windowed"_s, u"Run as an ordinary window, not a layer-shell surface."_s);
    parser.addOptions({focusOption, windowedOption});
    parser.process(app);

    // A shell is already running (Super keybind, or a second launch): hand over and exit.
    SingleInstance instance(SingleInstance::defaultName());
    if (instance.forward("focus"))
        return 0;
    instance.listen();

    QQuickStyle::setStyle(u"Basic"_s);
    applyShellFont();

    const auto paths = jarvis::protocol::controlPaths(jarvis::protocol::defaultRunDirectory());
    ControlOptions options;
    options.socketPath = paths.socketPath;
    options.secretPath = paths.secretPath;
    options.build = jarvis::protocol::readBuildId(jarvis::protocol::defaultBuildStampPath());
    auto* client = new ControlClient(options, &app);
    auto* shell = new ShellController(client, &app);

    QQmlApplicationEngine engine;
    engine.setInitialProperties({{u"shell"_s, QVariant::fromValue(shell)}});
    engine.loadFromModule("Jarvis.Shell", "Main");
    auto* window = engine.rootObjects().isEmpty() ? nullptr : qobject_cast<QQuickWindow*>(engine.rootObjects().constFirst());
    if (!window)
        return 1;

    const bool layerShell = !parser.isSet(windowedOption) && QGuiApplication::platformName().startsWith(u"wayland"_s);
    ShellSurface surface(window, layerShell);
    QObject::connect(&instance, &SingleInstance::messageReceived, &surface, [&surface, shell](const QByteArray&) {
        surface.summon();
        shell->requestComposerFocus();
    });
    QObject::connect(shell, &ShellController::dismissRequested, &surface, &ShellSurface::dismiss);

    surface.show();
    if (parser.isSet(focusOption)) {
        surface.summon();
        shell->requestComposerFocus();
    }
    client->start();
    return app.exec();
}
