#include <QCommandLineParser>
#include <QCoreApplication>
#include <QTimer>
#include <algorithm>
#include <cstdio>

#include "core/IdleConfig.h"
#include "core/IdlePolicy.h"
#include "core/LockLauncher.h"
#include "linux/IdleNotifier.h"
#include "linux/LogindWatcher.h"

using namespace Qt::StringLiterals;

#ifdef JARVIS_IDLE_TEST_HOOKS
// ASCII marker: Qt string literals are UTF-16, so grepping option names would be vacuous.
[[gnu::used]] extern const char kJarvisIdleTestHooksMarker[] = "JARVIS_IDLE_TEST_HOOKS_PRESENT";
#endif

int main(int argc, char* argv[])
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(u"jarvis-idle"_s);
    QCoreApplication::setApplicationVersion(QStringLiteral(JARVIS_IDLE_VERSION));

    QCommandLineParser parser;
    parser.setApplicationDescription(u"Locks the Rafiq session after idle time, on lid close, before sleep and on Super+L."_s);
    parser.addHelpOption();
    parser.addVersionOption();
    const QCommandLineOption minutesOption(u"lock-after-minutes"_s,
        u"Lock after <n> idle minutes (0 = never). Default: idle.lockAfterMinutes in jarvis.yaml, else 10."_s, u"n"_s);
    parser.addOption(minutesOption);
#ifdef JARVIS_IDLE_TEST_HOOKS
    const QCommandLineOption secondsOption(u"test-lock-after-seconds"_s, u"TEST BUILD ONLY"_s, u"n"_s);
    const QCommandLineOption commandOption(u"test-lock-command"_s, u"TEST BUILD ONLY: run this instead of jarvis-lock"_s, u"path"_s);
    parser.addOptions({secondsOption, commandOption});
#endif
    parser.process(app);

    int minutes = lockAfterMinutes(defaultConfigPath());
    if (parser.isSet(minutesOption))
        minutes = std::clamp(parser.value(minutesOption).toInt(), 0, 240);
    quint32 timeoutMs = quint32(minutes) * 60'000u;
    QString lockProgram = u"/usr/bin/jarvis-lock"_s;
#ifdef JARVIS_IDLE_TEST_HOOKS
    if (parser.isSet(secondsOption))
        timeoutMs = parser.value(secondsOption).toUInt() * 1000u;
    if (parser.isSet(commandOption))
        lockProgram = parser.value(commandOption);
#endif

    IdleNotifier notifier;
    if (!notifier.connectToCompositor()) {
        std::fprintf(stderr, "jarvis-idle: %s\n", qPrintable(notifier.error()));
        return 1;
    }
    notifier.setTimeoutMs(timeoutMs);

    IdlePolicy policy;
    LockLauncher launcher(lockProgram);
    LogindWatcher logind;
    if (!logind.start())
        std::fputs("jarvis-idle: logind is not reachable: no lock on lid close, sleep or Super+L\n", stderr);
    QTimer sleepFallback; // logind's InhibitDelayMaxSec is 5 s; never hold sleep longer than this
    sleepFallback.setSingleShot(true);
    sleepFallback.setInterval(4000);

    QObject::connect(&notifier, &IdleNotifier::idled, &policy, &IdlePolicy::onIdle);
    QObject::connect(&notifier, &IdleNotifier::compositorGone, &app, [] { QCoreApplication::exit(0); });
    QObject::connect(&logind, &LogindWatcher::lockRequested, &policy, &IdlePolicy::onLockRequested);
    QObject::connect(&logind, &LogindWatcher::lidClosed, &policy, &IdlePolicy::onLidClosed);
    QObject::connect(&logind, &LogindWatcher::sleepComing, &app, [&] {
        sleepFallback.start();
        policy.onSleepComing();
    });
    QObject::connect(&policy, &IdlePolicy::launchLock, &launcher, &LockLauncher::launch);
    QObject::connect(&launcher, &LockLauncher::confirmed, &policy, &IdlePolicy::onLockConfirmed);
    QObject::connect(&launcher, &LockLauncher::exited, &policy, &IdlePolicy::onLockExited);
    QObject::connect(&policy, &IdlePolicy::releaseSleepDelay, &app, [&] {
        sleepFallback.stop();
        logind.releaseSleepDelay();
    });
    QObject::connect(&sleepFallback, &QTimer::timeout, &logind, &LogindWatcher::releaseSleepDelay);
    QObject::connect(&policy, &IdlePolicy::gaveUp, &app, [](const QString& reason) {
        std::fprintf(stderr, "jarvis-idle: %s\n", qPrintable(reason));
    });
    return app.exec();
}
