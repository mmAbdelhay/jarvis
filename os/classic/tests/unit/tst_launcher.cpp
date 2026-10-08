#include <QSignalSpy>
#include <QtTest>

#include "DesktopEntry.h"
#include "Launcher.h"

using namespace Qt::StringLiterals;

namespace {
const QString kApps = QStringLiteral(JARVIS_CLASSIC_TEST_DATA "/applications");
struct Recorder {
    QString program;
    QStringList args;
    int calls = 0;
    bool result = true;
    Launcher::Starter starter()
    {
        return [this](const QString& p, const QStringList& a) {
            program = p;
            args = a;
            ++calls;
            return result;
        };
    }
};
} // namespace

class TestLauncher : public QObject {
    Q_OBJECT
private slots:
    void launchUsesArgvNotAShell()
    {
        Launcher launcher;
        Recorder r;
        launcher.setStarter(r.starter());
        QVERIFY(launcher.launchEntry(*jarvis::ui::parseDesktopEntry(kApps + u"/shellthing.desktop"_s)));
        QCOMPARE(r.program, u"sh"_s);
        QCOMPARE(r.args, (QStringList{u"-c"_s, u"echo a; echo b"_s})); // the app's own argv, nothing added
        QVERIFY(launcher.launchEntry(*jarvis::ui::parseDesktopEntry(kApps + u"/firefox.desktop"_s)));
        QCOMPARE(r.program, u"firefox-esr"_s);
        QVERIFY(r.args.isEmpty()); // %u dropped
    }

    void terminalAppsRunInFoot()
    {
        Launcher launcher;
        Recorder r;
        launcher.setStarter(r.starter());
        QVERIFY(launcher.launchEntry(*jarvis::ui::parseDesktopEntry(kApps + u"/htop.desktop"_s)));
        QCOMPARE(r.program, u"foot"_s);
        QCOMPARE(r.args, (QStringList{u"--"_s, u"htop"_s}));
    }

    void brokenExecIsRefused()
    {
        Launcher launcher;
        Recorder r;
        launcher.setStarter(r.starter());
        QSignalSpy failed(&launcher, &Launcher::failed);
        QVERIFY(!launcher.launchEntry(*jarvis::ui::parseDesktopEntry(kApps + u"/broken.desktop"_s)));
        QCOMPARE(r.calls, 0);
        QCOMPARE(failed.size(), 1);
        QCOMPARE(failed.at(0).at(0).toString(), u"That app's launcher is broken, so it was not started."_s);
    }

    void failedStartReports()
    {
        Launcher launcher;
        Recorder r;
        r.result = false;
        launcher.setStarter(r.starter());
        QSignalSpy failed(&launcher, &Launcher::failed);
        QVERIFY(!launcher.launch(u"pcmanfm-qt"_s));
        QCOMPARE(failed.at(0).at(0).toString(), u"Couldn't start pcmanfm-qt. Is it installed?"_s);
    }
};

QTEST_GUILESS_MAIN(TestLauncher)
#include "tst_launcher.moc"
