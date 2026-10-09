#include "app/SettingsMode.h"

#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTimer>

#include "Language.h"
#include "app/AppFont.h"
#include "app/ShellController.h"
#include "app/SingleInstance.h"
#include "control/ControlClient.h"
#include "protocol/BuildId.h"
#include "protocol/ControlPaths.h"

using namespace Qt::StringLiterals;

int runSettingsWindow(QGuiApplication& app, int quitAfterMs)
{
    SingleInstance instance(SingleInstance::nameFor(u"jarvis-shell-settings"_s));
    if (instance.forward("focus"))
        return 0;
    instance.listen();

    QQuickStyle::setStyle(u"Basic"_s);
    applyShellFont();
    jarvis::ui::LanguageManager language({u"jarvis-ui"_s, u"jarvis-shell"_s});
    language.setLanguage(jarvis::ui::languageFromEnvironment());

    const auto paths = jarvis::protocol::controlPaths(jarvis::protocol::defaultRunDirectory());
    ControlOptions options;
    options.socketPath = paths.socketPath;
    options.secretPath = paths.secretPath;
    options.build = jarvis::protocol::readBuildId(jarvis::protocol::defaultBuildStampPath());
    ControlClient client(options);
    ShellController shell(&client);
    shell.setLanguageApplier([&language](const QString& code) { return language.setLanguage(code); },
                             language.language());

    QQmlApplicationEngine engine;
    QObject::connect(&language, &jarvis::ui::LanguageManager::languageChanged, &engine, &QQmlEngine::retranslate);
    engine.setInitialProperties({{u"shell"_s, QVariant::fromValue(&shell)}});
    engine.loadFromModule("Jarvis.Shell", "SettingsWindow");
    auto* window = engine.rootObjects().isEmpty() ? nullptr
                                                  : qobject_cast<QQuickWindow*>(engine.rootObjects().constFirst());
    if (!window)
        return 1;
    QObject::connect(&instance, &SingleInstance::messageReceived, window, [window](const QByteArray&) {
        window->raise();
        window->requestActivate();
    });
    window->show();
    if (quitAfterMs > 0)
        QTimer::singleShot(quitAfterMs, &app, &QCoreApplication::quit);
    client.start();
    return app.exec();
}
