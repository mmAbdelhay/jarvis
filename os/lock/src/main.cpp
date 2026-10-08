#include <QCommandLineParser>
#include <QGuiApplication>
#include <QLockFile>
#include <QQuickStyle>
#include <QQuickView>
#include <QStandardPaths>
#include <QTimer>
#include <QtQml/qqmlextensionplugin.h>
#include <cstdio>

#include "JarvisFont.h"
#include "app/LockSession.h"
#include "auth/Authenticator.h"
#include "auth/Wipe.h"
#include "control/ControlClient.h"
#include "model/CurrentUser.h"
#include "model/LockModel.h"
#include "protocol/BuildId.h"
#include "protocol/ControlPaths.h"
#include "report/LockReporter.h"
#ifdef JARVIS_HAVE_PAM
#include "auth/PamAuthenticator.h"
#endif
#ifdef JARVIS_HAVE_SESSION_LOCK
#include "wayland/WaylandLockBackend.h"
#endif
#ifdef JARVIS_LOCK_TEST_HOOKS
#include <QFile>
// Plain ASCII marker so ci/test.sh can prove the hook build differs from the shipped one
// (option names are char16_t literals and never appear as ASCII in a binary).
[[gnu::used]] extern const char kJarvisLockTestHooksMarker[] = "JARVIS_LOCK_TEST_HOOKS_PRESENT";
#endif

Q_IMPORT_QML_PLUGIN(JarvisLockPlugin)

using namespace Qt::StringLiterals;

namespace {
void say(const QString& line)
{
    std::fputs(qPrintable(line + u'\n'), stdout);
    std::fflush(stdout);
}

QQuickView* makeView(LockModel* model, QScreen* screen, bool primary)
{
    auto* view = new QQuickView();
    view->setScreen(screen);
    view->setColor(Qt::black);
    view->setResizeMode(QQuickView::SizeRootObjectToView);
    view->setInitialProperties({{u"lock"_s, QVariant::fromValue(model)}, {u"primary"_s, primary}});
    view->loadFromModule("Jarvis.Lock", "LockScreen");
    return view;
}

#ifndef JARVIS_HAVE_PAM
// Off Linux (--windowed development only): nothing can unlock.
class NoAuthenticator : public Authenticator {
public:
    using Authenticator::Authenticator;
    void start(const QString&, QByteArray secret) override
    {
        jarvis::lock::wipe(secret);
        QTimer::singleShot(300, this, [this] { emit finished(false, u"Passwords can't be checked on this platform."_s); });
    }
};
#endif
} // namespace

int main(int argc, char* argv[])
{
    QGuiApplication app(argc, argv);
    QGuiApplication::setApplicationName(u"jarvis-lock"_s);
    QGuiApplication::setApplicationVersion(QStringLiteral(JARVIS_LOCK_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(u"Locks the Rafiq session (ext-session-lock-v1)."_s);
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption windowedOption(u"windowed"_s, u"Show the lock screen in a window without locking (development)."_s);
    const QCommandLineOption quitAfterOption(u"quit-after"_s, u"With --windowed: quit after <ms> (smoke tests)."_s, u"ms"_s);
    parser.addOptions({windowedOption, quitAfterOption});
#ifdef JARVIS_LOCK_TEST_HOOKS
    const QCommandLineOption passwordsOption(u"test-password-file"_s, u"TEST BUILD ONLY: type these passwords, one per line."_s, u"path"_s);
    parser.addOption(passwordsOption);
#endif
    parser.process(app);

    QQuickStyle::setStyle(u"Basic"_s);
    jarvis::ui::applyJarvisFont();
    const bool windowed = parser.isSet(windowedOption);

#ifdef JARVIS_HAVE_PAM
    PamAuthenticator authenticator;
#else
    NoAuthenticator authenticator;
#endif
    LockModel model(&authenticator, currentUser());

    if (windowed) {
        QQuickView* view = makeView(&model, QGuiApplication::primaryScreen(), true);
        view->resize(1280, 800);
        view->show();
        QObject::connect(&model, &LockModel::unlockRequested, &app, [] { QCoreApplication::exit(0); });
        if (parser.isSet(quitAfterOption))
            QTimer::singleShot(parser.value(quitAfterOption).toInt(), &app, [] { QCoreApplication::exit(0); });
        const int code = app.exec();
        delete view;
        return code;
    }

#ifndef JARVIS_HAVE_SESSION_LOCK
    std::fputs("jarvis-lock: this build cannot lock a session (use --windowed)\n", stderr);
    return LockSession::Refused;
#else
    if (!QGuiApplication::platformName().startsWith(u"wayland"_s)) {
        std::fputs("jarvis-lock: needs a Wayland session\n", stderr);
        return LockSession::Refused;
    }
    QLockFile instance(QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation) + u"/jarvis-lock.lock"_s);
    instance.setStaleLockTime(0);
    if (!instance.tryLock(0)) {
        say(u"already-running"_s);
        return LockSession::AlreadyRunning;
    }

    const auto paths = jarvis::protocol::controlPaths(jarvis::protocol::defaultRunDirectory());
    ControlOptions options;
    options.socketPath = paths.socketPath;
    options.secretPath = paths.secretPath;
    options.build = jarvis::protocol::readBuildId(jarvis::protocol::defaultBuildStampPath());
    ControlClient client(options);
    LockReporter reporter(&client);
    WaylandLockBackend backend([&model](QScreen* screen, bool primary) -> QQuickWindow* {
        return makeView(&model, screen, primary);
    });
    LockSession session(&backend, &reporter, &model, say);
    QObject::connect(&session, &LockSession::exitRequested, &app, [](int code) { QCoreApplication::exit(code); });

#ifdef JARVIS_LOCK_TEST_HOOKS
    QStringList typed;
    if (QFile file(parser.value(passwordsOption)); parser.isSet(passwordsOption) && file.open(QIODevice::ReadOnly))
        typed = QString::fromUtf8(file.readAll()).split(u'\n', Qt::SkipEmptyParts);
    int failuresSeen = 0;
    const auto typeNext = [&] {
        if (session.isLocked() && model.state() == u"ready" && !typed.isEmpty())
            model.submit(typed.takeFirst());
    };
    QObject::connect(&backend, &LockBackend::locked, &app, [&] { QTimer::singleShot(0, &app, typeNext); });
    QObject::connect(&model, &LockModel::stateChanged, &app, [&] {
        if (model.failures() > failuresSeen) {
            failuresSeen = model.failures();
            say(u"auth-failed"_s);
        }
        QTimer::singleShot(0, &app, typeNext);
    });
#endif

    client.start();
    session.start(); // on failure exitRequested follows once jarvisd has heard "unlocked"
    return app.exec();
#endif
}
