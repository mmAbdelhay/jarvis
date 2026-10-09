#include <QSignalSpy>
#include <QtTest>

#include "ShellFixture.h"
#include "models/CardModel.h"
#include "models/CuSessionModel.h"
#include "models/CuSettingsModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject cuState(bool active, const QJsonValue& paused = QJsonValue::Null)
{
    if (!active)
        return {{"active", false}};
    return {{"active", true}, {"sessionId", "s1"}, {"goal", "Export beach.xcf as PNG"}, {"apps", QJsonArray{"GIMP"}},
            {"step", 1}, {"maxSteps", 50},
            {"steps", QJsonArray{QJsonObject{{"title", "Open the File menu"}, {"status", "running"}}}},
            {"paused", paused}};
}

QJsonObject cuProviders()
{
    QJsonObject list = fixture::providerList();
    list["providers"] = QJsonArray{
        QJsonObject{{"id", "local"}, {"kind", "ollama"}, {"baseUrl", "http://localhost:11434"},
                    {"model", "qwen2.5vl:7b"}, {"hasKey", false}, {"vision", true},
                    {"computerUse", QJsonObject{{"enabled", true}, {"consentAt", QJsonValue::Null}}}},
        QJsonObject{{"id", "work"}, {"kind", "anthropic"}, {"baseUrl", "https://api.anthropic.com"},
                    {"model", "claude-sonnet-5-5"}, {"hasKey", true}, {"vision", true},
                    {"computerUse", QJsonObject{{"enabled", false}, {"consentAt", QJsonValue::Null}}}},
        QJsonObject{{"id", "tiny"}, {"kind", "ollama"}, {"baseUrl", "http://127.0.0.1:11434"},
                    {"model", "qwen3:1.7b"}, {"hasKey", false}, {"vision", false},
                    {"computerUse", QJsonObject{{"enabled", false}, {"consentAt", QJsonValue::Null}}}}};
    return list;
}

QJsonArray args(const QJsonObject& request) { return request.value("a").toArray(); }

int rowOf(CuSettingsModel* m, const QString& id)
{
    for (int i = 0; i < m->rowCount(); ++i)
        if (m->data(m->index(i), CuSettingsModel::IdRole).toString() == id)
            return i;
    return -1;
}
} // namespace

class TestCuChannels : public QObject {
    Q_OBJECT
private slots:
    void statePushShowsTheOverlayAndLowersTheShell()
    {
        ShellFixture f;
        QVERIFY(f.open());
        QSignalSpy dismissed(f.shell.get(), &ShellController::dismissRequested);
        f.push(u"cu:state"_s, cuState(true));
        QTRY_VERIFY(f.shell->cu()->active());
        QCOMPARE(f.shell->cu()->goal(), u"Export beach.xcf as PNG"_s);
        QCOMPARE(dismissed.size(), 1);
        f.push(u"cu:state"_s, cuState(true)); // next step: no second dismiss
        f.push(u"cu:state"_s, QJsonValue(u"junk"_s));
        f.push(u"sys:snapshot"_s, fixture::snapshot(false)); // marker: the pushes above arrived
        QTest::qWait(100);
        QCOMPARE(dismissed.size(), 1);
        QVERIFY(f.shell->cu()->active());
        f.push(u"cu:state"_s, cuState(false));
        QTRY_VERIFY(!f.shell->cu()->visible());
    }

    // Final review finding 4: Super+Esc (labwc) -> jarvis-session-key
    // --cu-stop -> jarvis-shell --cu-stop -> "cu-stop": Take over, without
    // summoning the shell over the app the user takes back.
    void superEscTakesOver()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"cu:state"_s, cuState(true));
        QTRY_VERIFY(f.shell->cu()->running());
        f.shell->setSurfaceShown(false);
        QVERIFY(f.shell->handleInstanceMessage("cu-stop"));
        QTRY_COMPARE(f.requests(u"cu:stop"_s).size(), 1);
        QVERIFY(!f.shell->surfaceShown());
        f.push(u"cu:state"_s, cuState(false));
        QTRY_VERIFY(!f.shell->cu()->active());
        QVERIFY(f.shell->handleInstanceMessage("cu-stop")); // no session: a known no-op
        QTest::qWait(50);
        QCOMPARE(f.requests(u"cu:stop"_s).size(), 1);
    }

    void takeOverSendsStop()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"cu:state"_s, cuState(true));
        QTRY_VERIFY(f.shell->cu()->running());
        f.shell->cu()->stop();
        QTRY_COMPARE(f.requests(u"cu:stop"_s).size(), 1);
        QCOMPARE(args(f.requests(u"cu:stop"_s).first()), QJsonArray{});
        QTRY_VERIFY(!f.shell->cu()->busy());
        f.replies.insert(u"cu:stop"_s, {false, {}, u"internal"_s, u"loop gone"_s});
        f.shell->cu()->stop();
        QTRY_COMPARE(f.shell->cu()->error(), u"Couldn't stop Jarvis: loop gone"_s);
    }

    void pausedThenResumedLowersTheShell()
    {
        ShellFixture f;
        QVERIFY(f.open());
        QSignalSpy dismissed(f.shell.get(), &ShellController::dismissRequested);
        f.push(u"cu:state"_s, cuState(true, u"excluded-focus"_s)); // the user pressed Super: the shell has focus
        QTRY_VERIFY(f.shell->cu()->paused());
        QCOMPARE(dismissed.size(), 0);
        f.shell->cu()->resume();
        QTRY_COMPARE(f.requests(u"cu:resume"_s).size(), 1);
        QCOMPARE(args(f.requests(u"cu:resume"_s).first()), QJsonArray{});
        f.push(u"cu:state"_s, cuState(true));
        QTRY_COMPARE(dismissed.size(), 1);
    }

    void cardDuringASessionSummonsAndAnswerLowers()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"cu:state"_s, cuState(true));
        QTRY_VERIFY(f.shell->cu()->running());
        QSignalSpy summoned(f.shell.get(), &ShellController::summonRequested);
        QSignalSpy dismissed(f.shell.get(), &ShellController::dismissRequested);
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s, u"screen.click"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        QCOMPARE(summoned.size(), 1);
        f.shell->decide(f.shell->chatCard(), true);
        QCOMPARE(dismissed.size(), 1);
        QTRY_COMPARE(f.requests(u"agent:confirm"_s).size(), 1);
    }

    void runningPushWhileACardIsOpenKeepsTheShell()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"cu:state"_s, cuState(true, u"excluded-focus"_s));
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s, u"screen.click"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        QSignalSpy dismissed(f.shell.get(), &ShellController::dismissRequested);
        f.push(u"cu:state"_s, cuState(true));
        QTRY_VERIFY(f.shell->cu()->running());
        QCOMPARE(dismissed.size(), 0);
    }

    void cuBeginCardSummons()
    {
        ShellFixture f;
        QVERIFY(f.open());
        QSignalSpy summoned(f.shell.get(), &ShellController::summonRequested);
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)})); // an ordinary card, no session
        QTRY_VERIFY(f.shell->chatCard()->active());
        QCOMPARE(summoned.size(), 0);
        f.shell->decide(f.shell->chatCard(), false);
        f.pushCard(fixture::card(u"c2"_s, {fixture::item(u"b"_s, u"cu.begin"_s)}));
        QTRY_COMPARE(f.shell->chatCard()->cardId(), u"c2"_s);
        QCOMPARE(summoned.size(), 1);
    }

    void connectionLossKeepsTheOverlayUntilReconnect()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"cu:state"_s, cuState(true));
        QTRY_VERIFY(f.shell->cu()->running());
        // The fixture reconnects within ~20 ms: watch the transition, not the state.
        QSignalSpy running(f.shell->cu(), &CuSessionModel::runningChanged);
        f.daemon.dropClients();
        QTRY_COMPARE(running.size(), 1); // running -> connection lost (still visible)
        QTRY_COMPARE(f.shell->connection(), u"open"_s);
        QTRY_VERIFY(!f.shell->cu()->visible());
    }

    void settingsComeFromTheProviderList()
    {
        ShellFixture f;
        f.replies.insert(u"provider:list"_s, {true, cuProviders()});
        QVERIFY(f.open());
        CuSettingsModel* s = f.shell->cuSettings();
        QTRY_COMPARE(s->count(), 3);
        QVERIFY(s->data(s->index(rowOf(s, u"local"_s)), CuSettingsModel::EnabledRole).toBool());
        QVERIFY(!s->data(s->index(rowOf(s, u"tiny"_s)), CuSettingsModel::VisionRole).toBool());
    }

    void cloudProviderAsksForConsentFirst()
    {
        ShellFixture f;
        f.replies.insert(u"provider:list"_s, {true, cuProviders()});
        QVERIFY(f.open());
        CuSettingsModel* s = f.shell->cuSettings();
        QTRY_COMPARE(s->count(), 3);
        s->setEnabled(rowOf(s, u"work"_s), true);
        QTest::qWait(50);
        QVERIFY(f.requests(u"cu:consent"_s).isEmpty());
        QVERIFY(f.requests(u"cu:setEnabled"_s).isEmpty());
        QCOMPARE(s->consentProviderId(), u"work"_s);
        s->acceptConsent();
        QTRY_COMPARE(f.requests(u"cu:consent"_s).size(), 1);
        QCOMPARE(args(f.requests(u"cu:consent"_s).first()), (QJsonArray{QJsonObject{{"providerId", "work"}}}));
        QTRY_COMPARE(f.requests(u"cu:setEnabled"_s).size(), 1);
        QCOMPARE(args(f.requests(u"cu:setEnabled"_s).first()),
                 (QJsonArray{QJsonObject{{"providerId", "work"}, {"enabled", true}}}));
        QTRY_VERIFY(s->data(s->index(rowOf(s, u"work"_s)), CuSettingsModel::EnabledRole).toBool());
    }

    void consentErrorSendsNoEnable()
    {
        ShellFixture f;
        f.replies.insert(u"provider:list"_s, {true, cuProviders()});
        f.replies.insert(u"cu:consent"_s, {false, {}, u"internal"_s, u"disk full"_s});
        QVERIFY(f.open());
        CuSettingsModel* s = f.shell->cuSettings();
        QTRY_COMPARE(s->count(), 3);
        s->setEnabled(rowOf(s, u"work"_s), true);
        s->acceptConsent();
        QTRY_COMPARE(s->note(), u"Couldn't change computer use: disk full"_s);
        QTest::qWait(50);
        QVERIFY(f.requests(u"cu:setEnabled"_s).isEmpty());
    }

    void localProviderSkipsConsent()
    {
        ShellFixture f;
        f.replies.insert(u"provider:list"_s, {true, cuProviders()});
        QVERIFY(f.open());
        CuSettingsModel* s = f.shell->cuSettings();
        QTRY_COMPARE(s->count(), 3);
        s->setEnabled(rowOf(s, u"local"_s), false);
        QTRY_COMPARE(f.requests(u"cu:setEnabled"_s).size(), 1);
        QCOMPARE(args(f.requests(u"cu:setEnabled"_s).first()),
                 (QJsonArray{QJsonObject{{"providerId", "local"}, {"enabled", false}}}));
        QVERIFY(f.requests(u"cu:consent"_s).isEmpty());
    }

    void olderJarvisSaysUnsupported()
    {
        ShellFixture f;
        f.replies.insert(u"provider:list"_s, {true, cuProviders()});
        f.replies.insert(u"cu:setEnabled"_s, {false, {}, u"unsupported"_s, u"unknown channel"_s});
        QVERIFY(f.open());
        CuSettingsModel* s = f.shell->cuSettings();
        QTRY_COMPARE(s->count(), 3);
        s->setEnabled(rowOf(s, u"local"_s), false);
        QTRY_COMPARE(s->note(), u"This version of Jarvis can't use the screen yet."_s);
    }
};

QTEST_MAIN(TestCuChannels)
#include "tst_cuchannels.moc"
