#include <QCommandLineParser>
#include <QDir>
#include <QGuiApplication>
#include <QLocale>
#include <QQmlApplicationEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QTimeZone>
#include <QTimer>
#include <QtQml/qqmlextensionplugin.h>

#include "FakeInstallerBackend.h"
#include "FakePower.h"
#include "InstallerModel.h"
#include "JarvisFont.h"
#include "Language.h"
#include "LiveKeyboard.h"
#include "OsRelease.h"
#ifdef JARVIS_HAVE_DBUS
#include "DBusInstallerBackend.h"
#include "LogindPower.h"
#endif

Q_IMPORT_QML_PLUGIN(JarvisInstallerPlugin)

using namespace Qt::StringLiterals;

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(u"jarvis-installer"_s);
    QGuiApplication::setApplicationVersion(QStringLiteral(JARVIS_INSTALLER_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(u"Installs the system from the live USB stick."_s);
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption windowed(u"windowed"_s, u"Run in a window instead of full screen."_s);
    const QCommandLineOption fake(u"fake-backend"_s, u"Use a scripted fake backend (development only)."_s, u"script.json"_s);
    const QCommandLineOption quitAfter(u"quit-after"_s, u"Quit after this many milliseconds (smoke tests)."_s, u"ms"_s);
    parser.addOptions({windowed, fake, quitAfter});
    parser.process(app);

    QQuickStyle::setStyle(u"Basic"_s);
    jarvis::ui::applyJarvisFont();
    jarvis::ui::LanguageManager language({u"jarvis-ui"_s, u"jarvis-installer"_s});

    InstallerBackend* backend = nullptr;
    PowerActions* power = nullptr;
    if (parser.isSet(fake)) {
        backend = FakeInstallerBackend::fromFile(parser.value(fake), &app);
        if (!backend) {
            qCritical("cannot read %s", qPrintable(parser.value(fake)));
            return 2;
        }
        power = new FakePower(&app);
    } else {
#ifdef JARVIS_HAVE_DBUS
        backend = new DBusInstallerBackend(QDBusConnection::systemBus(), &app);
        power = new LogindPower(QDBusConnection::systemBus(), &app);
#else
        qCritical("this build has no D-Bus: use --fake-backend");
        return 2;
#endif
    }

    auto* installer = new InstallerModel(backend, power, jarvis::ui::distroName(), QLocale::system().name(),
                                         QTimeZone::systemTimeZoneId(), &app);

    installer->setLanguageApplier([&language](const QString& code) { return language.setLanguage(code); });

    // In the live labwc session the chosen keyboard applies at once, so the
    // password is typed with the target's layout (contracts §11.5).
    if (!parser.isSet(fake) && !qEnvironmentVariableIsEmpty("LABWC_PID")
        && qEnvironmentVariable("JARVIS_INSTALLER_LIVE_KEYBOARD") != u"0"_s) {
        QString config = qEnvironmentVariable("XDG_CONFIG_HOME");
        if (config.isEmpty())
            config = QDir::homePath() + u"/.config"_s;
        installer->setLiveKeyboard(new LiveKeyboard(config, u"/etc/xdg/labwc/environment"_s,
                                                    {u"labwc"_s, u"--reconfigure"_s}, installer));
    }

    QQmlApplicationEngine engine;
    QObject::connect(&language, &jarvis::ui::LanguageManager::languageChanged, &engine, [&engine] { engine.retranslate(); });
    engine.setInitialProperties({{u"installer"_s, QVariant::fromValue(installer)}});
    engine.loadFromModule("Jarvis.Installer", "Main");
    auto* window = engine.rootObjects().isEmpty() ? nullptr : qobject_cast<QQuickWindow*>(engine.rootObjects().constFirst());
    if (!window)
        return 1;
    if (parser.isSet(windowed))
        window->show();
    else
        window->showFullScreen();
    if (parser.isSet(quitAfter))
        QTimer::singleShot(parser.value(quitAfter).toInt(), &app, &QCoreApplication::quit);

    installer->start();
    return app.exec();
}
