#include <QJsonArray>
#include <QJsonDocument>
#include <QtTest>

#include "AccountChoice.h"
#include "BrainChoice.h"
#include "FakeInstallerBackend.h"
#include "FakePower.h"
#include "Fixtures.h"
#include "InstallProgress.h"
#include "InstallerModel.h"
#include "LiveKeyboard.h"

#include <QTemporaryDir>

using namespace Qt::StringLiterals;

namespace {
const QString testPassword = u"abcdEF12"_s;
struct Fixture {
    FakeInstallerBackend backend;
    FakePower power;
    InstallerModel model{&backend, &power, u"Rafiq"_s, u"en_US"_s, "Africa/Cairo"};

    Fixture()
    {
        backend.probeResult = loadFixture(u"probe-windows.json"_s);
        backend.planTemplate = loadFixture(u"plan-alongside.json"_s);
    }
    bool probe()
    {
        model.start();
        return QTest::qWaitFor([this] { return model.probed(); }, 2000);
    }
    bool toBrain()
    {
        if (!probe())
            return false;
        model.next(); // → Disk (alongside is the default)
        model.next(); // → Account
        model.account()->setFullName(u"Mohamed Abdelhay"_s);
        model.account()->setPassword(u"abcdEF12"_s);
        model.account()->setConfirm(u"abcdEF12"_s);
        model.next(); // → Brain
        return model.step() == InstallerModel::Brain;
    }
    bool toReview()
    {
        if (!toBrain())
            return false;
        model.next();
        return QTest::qWaitFor([this] { return model.step() == InstallerModel::Review; }, 2000);
    }
    qsizetype count(const QString& method) const { return backend.calls.count(method); }
};
} // namespace

class TestInstallerModel : public QObject {
    Q_OBJECT
private slots:
    void startsOnWelcomeAndProbes()
    {
        Fixture f;
        QCOMPARE(f.model.step(), int(InstallerModel::Welcome));
        QCOMPARE(f.model.stepLabels(), (QStringList{u"Welcome"_s, u"Disk"_s, u"Your account"_s, u"Jarvis's brain"_s,
                                                    u"Review"_s, u"Installing"_s, u"Done"_s}));
        f.model.start();
        QVERIFY(f.model.busy());
        QVERIFY(!f.model.canContinue());
        QVERIFY(f.probe());
        QVERIFY(f.model.canContinue());
        QVERIFY(!f.model.backVisible());
        QCOMPARE(f.model.nextLabel(), u"Continue"_s);
        QCOMPARE(f.backend.calls, QStringList{u"Probe"_s});
    }

    void noUefiStopsAtWelcome()
    {
        Fixture f;
        f.backend.probeResult.insert("uefi", false);
        QVERIFY(f.probe());
        QVERIFY(!f.model.canContinue());
        QVERIFY(f.model.blockText().contains(u"Rafiq needs UEFI"_s));
        f.model.next();
        QCOMPARE(f.model.step(), int(InstallerModel::Welcome));
    }

    void probeFailureCanBeRetried()
    {
        Fixture f;
        f.backend.failNext = u"Probe"_s;
        f.model.start();
        QTRY_VERIFY(f.model.canRetryProbe());
        QVERIFY(f.model.errorText().startsWith(u"Couldn't look at this computer's disks"_s));
        QVERIFY(f.probe());
        QCOMPARE(f.model.errorText(), QString());
    }

    void choicesGoOutAtBrainAndReviewShowsThePlanVerbatim()
    {
        Fixture f;
        QVERIFY(f.toBrain());
        f.model.next();
        QVERIFY(f.model.busy());
        QCOMPARE(f.model.nextLabel(), u"Checking…"_s);
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Review));
        QCOMPARE(f.backend.calls, (QStringList{u"Probe"_s, u"Plan"_s}));
        const QJsonObject expected{
            {"locale", "en_US.UTF-8"}, {"keyboard", "us"}, {"timezone", "Africa/Cairo"},
            {"disk", QJsonObject{{"path", "/dev/nvme0n1"}, {"mode", "alongside"}, {"alongsideSizeBytes", 147000000000.0}}},
            {"encrypt", true},
            {"user", QJsonObject{{"fullName", "Mohamed Abdelhay"}, {"username", "mohamed"},
                                 {"hostname", "mohamed-computer"}, {"autologin", false}}},
            {"brain", QJsonObject{{"kind", "local"}, {"modelId", "qwen3-8b"}}}};
        QVERIFY(f.backend.choices.last() == expected);
        QVERIFY(!QJsonDocument(f.backend.choices.last()).toJson().contains(testPassword.toUtf8()));
        QStringList summary;
        for (const QJsonValue& line : loadFixture(u"plan-alongside.json"_s).value("summary").toArray())
            summary << line.toString();
        QCOMPARE(f.model.summary(), summary);
        QCOMPARE(f.model.warnings().size(), 1);
        QCOMPARE(f.model.diskAfter().size(), 2);
        QCOMPARE(f.model.nextLabel(), u"Install"_s);
        QCOMPARE(f.model.nextVariant(), u"approve"_s);
        QCOMPARE(f.count(u"Execute"_s), 0); // nothing destructive before Install
    }

    void backFromReviewChangesNothing()
    {
        Fixture f;
        QVERIFY(f.toReview());
        const QJsonObject before = f.model.choices();
        f.model.back();
        QCOMPARE(f.model.step(), int(InstallerModel::Brain));
        QCOMPARE(f.model.planId(), QString());
        QVERIFY(f.model.summary().isEmpty());
        QCOMPARE(f.backend.calls, (QStringList{u"Probe"_s, u"Plan"_s}));
        QCOMPARE(f.model.choices(), before);
    }

    void backFromReviewThenChangeReplans()
    {
        Fixture f;
        QVERIFY(f.toReview());
        QCOMPARE(f.model.planId(), u"fake-plan-1"_s);
        f.model.back();
        f.model.brain()->setModelId(u"qwen3-4b"_s);
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Review));
        QCOMPARE(f.model.planId(), u"fake-plan-2"_s);
        QCOMPARE(f.backend.choices.last().value("brain").toObject().value("modelId").toString(), u"qwen3-4b"_s);
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Installing));
        QCOMPARE(f.backend.executedPlanIds, QStringList{u"fake-plan-2"_s});
    }

    void goToAnEarlierStepDropsThePlan()
    {
        Fixture f;
        QVERIFY(f.toReview());
        f.model.goTo(5);
        QCOMPARE(f.model.step(), int(InstallerModel::Review));
        f.model.goTo(1);
        QCOMPARE(f.model.step(), int(InstallerModel::Disk));
        QCOMPARE(f.model.planId(), QString());
    }

    void refusalJumpsToTheOwningStepInPlainWords()
    {
        Fixture f;
        QVERIFY(f.toBrain());
        f.backend.refuseKey = u"ntfs-hibernated"_s;
        f.backend.refuseMessage = u"ntfsresize reports a hibernated volume"_s;
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Disk));
        QVERIFY(f.model.refusalText().contains(u"hold Shift + Shut down"_s));
        QVERIFY(!f.model.refusalText().contains(u"ntfs-hibernated"_s));
        QCOMPARE(f.count(u"Execute"_s), 0);
        f.model.next();
        QCOMPARE(f.model.refusalText(), QString());
    }

    void alongsideNoWindowsReturnsToDisk()
    {
        Fixture f;
        QVERIFY(f.toBrain());
        f.backend.refuseKey = u"alongside-no-windows"_s;
        f.backend.refuseMessage = u"No Windows partition."_s;
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Disk));
        QVERIFY(!f.model.refusalText().isEmpty());
        QCOMPARE(f.count(u"Execute"_s), 0);
    }

    void unknownRefusalShowsTheBackendWords()
    {
        Fixture f;
        QVERIFY(f.toBrain());
        f.backend.refuseKey = u"unknown-key"_s; // not a contract key: the backend's words are shown
        f.backend.refuseMessage = u"Something odd."_s;
        f.model.next();
        QTRY_VERIFY(!f.model.refusalText().isEmpty());
        QCOMPARE(f.model.step(), int(InstallerModel::Brain));
        QCOMPARE(f.model.refusalText(), u"Something odd."_s);
    }

    void planCallFailureStaysOnBrain()
    {
        Fixture f;
        QVERIFY(f.toBrain());
        f.backend.failNext = u"Plan"_s;
        f.model.next();
        QTRY_VERIFY(!f.model.errorText().isEmpty());
        QCOMPARE(f.model.step(), int(InstallerModel::Brain));
        QVERIFY(!f.model.busy());
        QVERIFY(f.model.errorText().contains(u"didn't answer"_s));
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Review));
    }

    void installSendsSecretsOnlyThroughExecute()
    {
        Fixture f;
        QVERIFY(f.toReview());
        f.model.next();
        QCOMPARE(f.model.nextLabel(), u"Starting…"_s);
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Installing));
        const QJsonObject sentSecrets = QJsonDocument::fromJson(f.backend.secrets.last()).object();
        const QJsonObject expectedSecrets{{"userPassword", testPassword}, {"luksPassphrase", testPassword}};
        QVERIFY(sentSecrets == expectedSecrets);
        QVERIFY(f.model.account()->password().isEmpty());
        QVERIFY(f.model.account()->confirm().isEmpty());
        for (const QJsonObject& c : f.backend.choices)
            QVERIFY(!QJsonDocument(c).toJson().contains(testPassword.toUtf8()));
        QVERIFY(!f.model.backVisible());
    }

    void installIsSentOnce()
    {
        Fixture f;
        QVERIFY(f.toReview());
        f.model.next();
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Installing));
        f.model.next();
        QCOMPARE(f.count(u"Execute"_s), 1);
    }

    void executeFailureKeepsReviewAndPasswords()
    {
        Fixture f;
        QVERIFY(f.toReview());
        f.backend.failNext = u"Execute"_s;
        f.model.next();
        QTRY_VERIFY(!f.model.errorText().isEmpty());
        QCOMPARE(f.model.step(), int(InstallerModel::Review));
        QVERIFY(f.model.errorText().startsWith(u"The installation didn't start"_s));
        QVERIFY(f.model.account()->password() == testPassword);
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Installing));
    }

    void progressBeforeInstallIsIgnored()
    {
        Fixture f;
        QVERIFY(f.toReview());
        emit f.backend.progress(u"copy"_s, 50, u"x"_s);
        emit f.backend.finished(true, {}, {});
        QCOMPARE(f.model.step(), int(InstallerModel::Review));
        QCOMPARE(f.model.progress()->currentPercent(), 0);
    }

    void progressThenDoneThenRestart()
    {
        Fixture f;
        QVERIFY(f.toReview());
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Installing));
        QVERIFY(!f.model.canContinue());
        QCOMPARE(f.model.nextLabel(), u"Next"_s);
        emit f.backend.progress(u"copy"_s, 62, u"Copying system files"_s);
        emit f.backend.modelProgress(37, u"1.9 of 5.2 GB"_s);
        QCOMPARE(f.model.progress()->currentPercent(), 62);
        QCOMPARE(f.model.progress()->modelPercent(), 37);
        emit f.backend.finished(true, {}, {});
        QCOMPARE(f.model.step(), int(InstallerModel::Done));
        QCOMPARE(f.model.nextLabel(), u"Restart now"_s);
        f.model.next();
        QCOMPARE(f.power.calls, QStringList{u"Reboot"_s});
    }

    void failureOffersRestart()
    {
        Fixture f;
        QVERIFY(f.toReview());
        f.model.next();
        QTRY_COMPARE(f.model.step(), int(InstallerModel::Installing));
        emit f.backend.finished(false, u"copy"_s, u"unsquashfs: write error"_s);
        QCOMPARE(f.model.step(), int(InstallerModel::Installing));
        QVERIFY(f.model.progress()->failed());
        QVERIFY(f.model.canContinue());
        QCOMPARE(f.model.nextLabel(), u"Restart now"_s);
        QVERIFY(!f.model.backVisible());
        f.model.next();
        QCOMPARE(f.power.calls, QStringList{u"Reboot"_s});
    }

    void restartFailureIsShown()
    {
        Fixture f;
        emit f.power.failed(u"Not allowed"_s);
        QCOMPARE(f.model.errorText(), u"Couldn't restart: Not allowed"_s);
    }

    void liveSessionFollowsTheChosenKeyboard()
    {
        QTemporaryDir dir;
        Fixture f;
        LiveKeyboard live(dir.path(), dir.filePath(u"none"_s), {u"/bin/sh"_s, u"-c"_s, u"true"_s});
        f.model.setLiveKeyboard(&live);
        QFile env(dir.filePath(u"labwc/environment"_s));
        QVERIFY(env.exists());
        QVERIFY(f.model.locale()->typingMatches());
        f.model.locale()->setKeyboard(u"fr"_s);
        QCOMPARE(f.model.locale()->typingKeyboard(), u"fr"_s);
        QVERIFY(f.model.locale()->typingMatches());
        QVERIFY(env.open(QIODevice::ReadOnly));
        QVERIFY(env.readAll().contains("XKB_DEFAULT_LAYOUT=fr\n"));
    }

    void keyboardMismatchWhenTheLiveSessionCannotFollow()
    {
        QTemporaryDir dir;
        Fixture f;
        LiveKeyboard live(dir.path(), dir.filePath(u"none"_s), {dir.filePath(u"no-such-labwc"_s)});
        f.model.setLiveKeyboard(&live);
        f.model.locale()->setKeyboard(u"fr"_s);
        QCOMPARE(f.model.locale()->typingKeyboard(), u"us"_s);
        QVERIFY(!f.model.locale()->typingMatches());
    }
};

QTEST_GUILESS_MAIN(TestInstallerModel)
#include "tst_installermodel.moc"
