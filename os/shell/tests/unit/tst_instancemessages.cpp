#include <QPointer>
#include <QSignalSpy>
#include <QStandardPaths>
#include <QtTest>

#include "FakeRecorder.h"
#include "ShellFixture.h"
#include "models/voice/VoiceModel.h"

using namespace Qt::StringLiterals;

class TestInstanceMessages : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() { QStandardPaths::setTestModeEnabled(true); }

    void focusAndPushToTalk()
    {
        ShellFixture f;
        QPointer<FakeRecorder> last;
        f.shell->voice()->setRecorderFactory([&](QObject* parent) {
            auto* r = new FakeRecorder(parent);
            last = r;
            return r;
        });
        QVERIFY(f.open());
        f.push(u"sys:snapshot"_s, fixture::snapshot(false, true));
        QTRY_VERIFY(f.shell->voice()->available());
        QSignalSpy focus(f.shell.get(), &ShellController::composerFocusRequested);
        QVERIFY(f.shell->handleInstanceMessage("focus"));
        QCOMPARE(focus.size(), 1);
        f.shell->showView(u"audit"_s);
        f.shell->setSurfaceShown(false);
        QVERIFY(f.shell->handleInstanceMessage("ptt"));
        QCOMPARE(f.shell->view(), u"chat"_s);
        QVERIFY(f.shell->surfaceShown());
        QVERIFY(last && last->started);
        QVERIFY(f.shell->handleInstanceMessage("ptt")); // second press sends
        QVERIFY(last->stopped);
        QVERIFY(!f.shell->handleInstanceMessage("rm -rf"));
    }
};

QTEST_GUILESS_MAIN(TestInstanceMessages)
#include "tst_instancemessages.moc"
