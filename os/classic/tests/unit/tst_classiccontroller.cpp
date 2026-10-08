#include <QFile>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtTest>

#include "AppsModel.h"
#include "ClassicController.h"
#include "Launcher.h"

using namespace Qt::StringLiterals;

namespace {
const QString kApps = QStringLiteral(JARVIS_CLASSIC_TEST_DATA "/applications");
struct Rig {
    AppsModel apps{{kApps}, {u"labwc"_s}};
    Launcher launcher;
    QList<QStringList> started; // program + args
    bool ok = true;
    ClassicController controller{&apps, &launcher, false};
    Rig()
    {
        launcher.setStarter([this](const QString& p, const QStringList& a) {
            started.append(QStringList{p} + a);
            return ok;
        });
    }
};
} // namespace

class TestClassicController : public QObject {
    Q_OBJECT
private slots:
    void fixedButtonsStartTheContractPrograms()
    {
        Rig rig;
        rig.controller.openTerminal();
        rig.controller.openFiles();
        rig.controller.openSettings();
        QCOMPARE(rig.started, (QList<QStringList>{{u"foot"_s}, {u"pcmanfm-qt"_s}, {u"jarvis-shell"_s, u"--settings"_s}}));
    }

    void launchingAnAppClosesTheMenu()
    {
        Rig rig;
        rig.controller.toggleApps();
        QVERIFY(rig.controller.appsOpen());
        rig.controller.launchApp(u"foot"_s);
        QCOMPARE(rig.started.last(), QStringList{u"foot"_s});
        QVERIFY(!rig.controller.appsOpen());
    }

    void unknownAppIdDoesNothing()
    {
        Rig rig;
        rig.controller.launchApp(u"broken"_s);   // filtered out of the model
        rig.controller.launchApp(u"../evil"_s);
        QVERIFY(rig.started.isEmpty());
    }

    void launchFirstUsesTheFilteredList()
    {
        Rig rig;
        rig.controller.toggleApps();
        rig.apps.setFilter(u"htop"_s);
        rig.controller.launchFirst();
        QCOMPARE(rig.started.last(), (QStringList{u"foot"_s, u"--"_s, u"htop"_s}));
    }

    void failureBecomesANotice()
    {
        Rig rig;
        rig.ok = false;
        QSignalSpy notice(&rig.controller, &ClassicController::noticeChanged);
        rig.controller.openFiles();
        QCOMPARE(rig.controller.notice(), u"Couldn't start pcmanfm-qt. Is it installed?"_s);
        rig.controller.dismissNotice();
        QVERIFY(rig.controller.notice().isEmpty());
        QCOMPARE(notice.size(), 2);
    }

    void chatAndAppsToggle()
    {
        Rig rig;
        QSignalSpy chat(&rig.controller, &ClassicController::chatOpenChanged);
        rig.controller.toggleChat();
        QVERIFY(rig.controller.chatOpen());
        rig.controller.openChat(); // already open: no signal
        rig.controller.toggleChat();
        QVERIFY(!rig.controller.chatOpen());
        QCOMPARE(chat.size(), 2);
    }

    void fallbackFollowsTheMarker()
    {
        QTemporaryDir dir;
        const QString marker = dir.filePath(u"jarvis/classic-fallback"_s);
        QVERIFY(!ClassicController::fallbackActive(marker));
        QVERIFY(QDir(dir.path()).mkpath(u"jarvis"_s));
        QFile(marker).open(QIODevice::WriteOnly);
        QVERIFY(ClassicController::fallbackActive(marker));
        qputenv("XDG_RUNTIME_DIR", "/run/user/1000");
        QCOMPARE(ClassicController::defaultMarkerPath(), u"/run/user/1000/jarvis/classic-fallback"_s);
    }
};

QTEST_GUILESS_MAIN(TestClassicController)
#include "tst_classiccontroller.moc"
