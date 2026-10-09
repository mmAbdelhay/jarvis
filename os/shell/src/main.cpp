#include <QCommandLineParser>
#include <QDateTime>
#include <QGuiApplication>
#include <QProcess>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QStandardPaths>
#include <QtQml/qqmlextensionplugin.h>

#include "Language.h"
#include "app/AppFont.h"
#include "app/ClassicRedirect.h"
#include "app/CuOverlayManager.h"
#include "app/ShellController.h"
#include "app/ShellIdentity.h"
#include "app/ShellSurface.h"
#include "app/SingleInstance.h"
#include "app/SettingsMode.h"
#include "control/ControlClient.h"
#include "protocol/BuildId.h"
#include "protocol/ControlPaths.h"

Q_IMPORT_QML_PLUGIN(JarvisShellPlugin)

using namespace Qt::StringLiterals;

int main(int argc, char* argv[])
{
    // Super+Esc (labwc) -> jarvis-session-key --cu-stop: Take over from
    // computer use. Hand "cu-stop" to the running shell without starting a
    // GUI (fast: the user is taking the screen back) and never summon it.
    for (int i = 1; i < argc; ++i) {
        if (qstrcmp(argv[i], "--cu-stop") == 0) {
            QCoreApplication core(argc, argv);
            SingleInstance running(SingleInstance::defaultName());
            running.forward("cu-stop", 500);
            return 0;
        }
    }
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(u"jarvis-shell"_s);
    QGuiApplication::setApplicationVersion(QStringLiteral(JARVIS_SHELL_VERSION));
    // Rafiq v1.1 contracts §1: jarvis-cu excludes the shell by this app_id.
    jarvis::shell::applyShellIdentity();

    QCommandLineParser parser;
    parser.setApplicationDescription(u"The Jarvis OS shell."_s);
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption focusOption(u"focus"_s, u"Bring the shell to the front and focus the chat."_s);
    const QCommandLineOption windowedOption(u"windowed"_s, u"Run as an ordinary window, not a layer-shell surface."_s);
    // M3 contracts §5.15: Super+Space runs `jarvis-shell --voice`; --ptt is the older spelling.
    const QCommandLineOption pttOption(QStringList{u"voice"_s, u"ptt"_s},
                                       u"Push-to-talk: start, or send, a voice message (Super+Space)."_s);
    const QCommandLineOption cuStopOption(u"cu-stop"_s, u"Take over from computer use (Super+Esc)."_s);
    parser.addOptions({focusOption, windowedOption, pttOption, cuStopOption});
    const QCommandLineOption settingsOption(u"settings"_s, u"Open Settings in its own window (classic mode)."_s);
    const QCommandLineOption quitAfterOption(u"quit-after"_s, u"With --settings: quit after <ms> (smoke tests)."_s, u"ms"_s);
    parser.addOptions({settingsOption, quitAfterOption});
    parser.process(app);

    if (parser.isSet(settingsOption))
        return runSettingsWindow(app, parser.isSet(quitAfterOption) ? parser.value(quitAfterOption).toInt() : -1);

    // Classic fallback (contracts §6.14): Super and --ptt open the classic chat panel.
    if (jarvis::shell::redirectToClassic(jarvis::shell::classicMarkerPath(),
                                         [](const QString& program, const QStringList& args) {
                                             return QProcess::startDetached(program, args);
                                         }))
        return 0;

    // A shell is already running (Super keybind, or a second launch): hand over and exit.
    SingleInstance instance(SingleInstance::defaultName());
    if (instance.forward(parser.isSet(pttOption) ? "ptt" : "focus"))
        return 0;
    instance.listen();

    QQuickStyle::setStyle(u"Basic"_s);
    applyShellFont();
    // Rafiq M4 contracts §3: start in the session's language; jarvisd's
    // ui:language push (os.language) takes over once connected.
    jarvis::ui::LanguageManager language({u"jarvis-ui"_s, u"jarvis-shell"_s});
    language.setLanguage(jarvis::ui::languageFromEnvironment());

    const auto paths = jarvis::protocol::controlPaths(jarvis::protocol::defaultRunDirectory());
    ControlOptions options;
    options.socketPath = paths.socketPath;
    options.secretPath = paths.secretPath;
    options.build = jarvis::protocol::readBuildId(jarvis::protocol::defaultBuildStampPath());
    auto* client = new ControlClient(options, &app);
    auto* shell = new ShellController(client, &app);
    shell->setLanguageApplier([&language](const QString& code) { return language.setLanguage(code); },
                              language.language());

    QQmlApplicationEngine engine;
    QObject::connect(&language, &jarvis::ui::LanguageManager::languageChanged, &engine, &QQmlEngine::retranslate);

    engine.setInitialProperties({{u"shell"_s, QVariant::fromValue(shell)}});
    engine.loadFromModule("Jarvis.Shell", "Main");
    auto* window = engine.rootObjects().isEmpty() ? nullptr : qobject_cast<QQuickWindow*>(engine.rootObjects().constFirst());
    if (!window)
        return 1;

    const bool layerShell = !parser.isSet(windowedOption) && QGuiApplication::platformName().startsWith(u"wayland"_s);
    // Contracts §6.14: jarvisd down while the shell runs -> "Switch to classic".
    // Only in the Rafiq session (the layer-shell desktop with jarvis-classic
    // installed): write the marker jarvis-shell-guard reads and quit cleanly;
    // the session loop relaunches the guard, which starts jarvis-classic.
    if (layerShell && !QStandardPaths::findExecutable(u"jarvis-classic"_s).isEmpty()) {
        shell->setClassicSwitcher([] {
            if (!jarvis::shell::writeClassicMarker(jarvis::shell::classicMarkerPath(), u"user"_s,
                                                   QDateTime::currentSecsSinceEpoch()))
                return false;
            QCoreApplication::exit(0);
            return true;
        });
    }
    ShellSurface surface(window, layerShell);
    // Rafiq v1.1 design §2.3: border, pill and step panel while Jarvis controls the screen.
    CuOverlayManager overlay(&engine, shell->cu(), layerShell);
    QObject::connect(shell, &ShellController::summonRequested, &surface, [&surface, shell] {
        surface.summon();
        shell->setSurfaceShown(true);
    });
    QObject::connect(&instance, &SingleInstance::messageReceived, &surface, [&surface, shell](const QByteArray& message) {
        if (message == "cu-stop") { // the user takes the app back: do not cover it with the shell
            shell->handleInstanceMessage(message);
            return;
        }
        surface.summon();
        shell->setSurfaceShown(true);
        shell->handleInstanceMessage(message);
    });
    // Voice may answer a card only while the shell is on screen (design §3.2).
    QObject::connect(shell, &ShellController::dismissRequested, &surface, [&surface, shell] {
        surface.dismiss();
        shell->setSurfaceShown(false);
    });

    surface.show();
    if (parser.isSet(focusOption) || parser.isSet(pttOption)) {
        surface.summon();
        shell->setSurfaceShown(true);
        shell->handleInstanceMessage(parser.isSet(pttOption) ? "ptt" : "focus");
    }
    client->start();
    return app.exec();
}
