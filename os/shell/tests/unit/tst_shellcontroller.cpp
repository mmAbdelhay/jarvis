#include <QDateTime>
#include <QJsonArray>
#include <QSignalSpy>
#include <QtTest>
#include <memory>

#include "FakeDaemon.h"
#include "app/ShellController.h"
#include "control/ControlClient.h"
#include "models/CardModel.h"
#include "models/Conversation.h"
#include "models/DoctorModel.h"
#include "models/ProviderListModel.h"
#include "models/ProviderModel.h"
#include "models/SystemModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject snapshot(bool online)
{
    return {{"online", online}, {"network", QJsonObject{{"connectivity", online ? "full" : "none"}, {"wifiSsid", QJsonValue::Null}}},
            {"memTotalBytes", 0}, {"memUsedBytes", 0}, {"disk", QJsonObject{}}, {"failedUnits", QJsonArray{}},
            {"model", QJsonValue::Null}};
}

QJsonObject installItem(const QString& id, const QString& title, const QString& source)
{
    return {{"itemId", id}, {"tool", "pkg.install"}, {"title", title}, {"detail", ""},
            {"source", source}, {"risk", "confirm"}, {"secretFields", QJsonArray{}}};
}

QJsonObject activeProvider()
{
    return {{"kind", "ollama"}, {"baseUrl", "http://localhost:11434"}, {"model", "qwen3:8b"}, {"hasKey", false}};
}

QJsonObject workProvider()
{
    return {{"id", "work"}, {"kind", "anthropic"}, {"baseUrl", "https://api.anthropic.com"}, {"model", "claude-sonnet-5-5"}, {"hasKey", true}};
}

QJsonObject newShapeList()
{
    QJsonObject local = activeProvider();
    local.insert("id", "local");
    return {{"providers", QJsonArray{local, workProvider()}}, {"activeId", "local"}, {"allowCloudFallback", false},
            {"kinds", QJsonArray{"anthropic", "openai-compatible", "ollama", "gemini"}}};
}

QJsonObject okProbe()
{
    return {{"ok", true}, {"supportsTools", true}, {"models", QJsonArray{"qwen3:8b"}}};
}

QJsonObject card(const QString& cardId, const QJsonValue& turnId)
{
    return {{"cardId", cardId}, {"turnId", turnId},
            {"expiresAt", double(QDateTime::currentMSecsSinceEpoch() + 300000)},
            {"items", QJsonArray{QJsonObject{{"itemId", "i1"}, {"tool", "svc.restart"},
                                             {"title", "Restart NetworkManager"},
                                             {"detail", "The network drops for about 3 seconds."},
                                             {"source", "system"}, {"risk", "confirm"},
                                             {"secretFields", QJsonArray{}}}}}};
}

struct Fixture {
    FakeDaemon daemon;
    QJsonObject providerList{{"active", QJsonValue::Null},
                             {"kinds", QJsonArray{"anthropic", "openai-compatible", "ollama"}}};
    QJsonObject doctorState{{"active", true}, {"steps", QJsonArray{}}, {"networks", QJsonArray{}}, {"done", QJsonValue::Null}};
    QStringList launched;
    bool launchWorks = true;
    std::unique_ptr<ControlClient> client;
    std::unique_ptr<ShellController> shell;

    Fixture()
    {
        daemon.handler = [this](const QString& channel, const QJsonArray&, quint64) -> FakeDaemon::Reply {
            if (channel == u"provider:list")
                return {true, providerList};
            if (channel == u"doctor:start" || channel == u"doctor:skip")
                return {true, doctorState};
            if (channel == u"audit:list")
                return {true, QJsonArray{}};
            if (channel == u"agent:prompt")
                return {true, QJsonObject{{"turnId", "t1"}}};
            return {true, QJsonValue::Null};
        };
        daemon.listen();
        ControlOptions options;
        options.socketPath = daemon.socketPath();
        options.secretPath = daemon.secretPath();
        options.backoffMs = {20};
        client = std::make_unique<ControlClient>(options);
        shell = std::make_unique<ShellController>(client.get());
        shell->setLauncher([this](const QString& program) {
            launched.append(program);
            return launchWorks;
        });
    }

    bool open()
    {
        client->start();
        return QTest::qWaitFor([this] { return shell->connection() == u"open"; }, 3000);
    }

    QString lastNotice() const
    {
        const Conversation* c = shell->conversation();
        return c->rowCount() ? c->get(c->rowCount() - 1).value(u"text"_s).toString() : QString();
    }
};
} // namespace

class TestShellController : public QObject {
    Q_OBJECT
private slots:
    void startsConnecting()
    {
        Fixture f;
        QCOMPARE(f.shell->view(), u"loading"_s);
        QCOMPARE(f.shell->connection(), u"connecting"_s);
        QCOMPARE(f.shell->bannerText(), u"Connecting to Jarvis…"_s);
    }

    void firstBootShowsSetup()
    {
        Fixture f;
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"setup"_s);
        QCOMPARE(f.shell->bannerText(), QString());
        QCOMPARE(f.daemon.requests(u"audit:list"_s).size(), 1);
    }

    void configuredGoesToChat()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        QCOMPARE(f.shell->provider()->activeModel(), u"qwen3:8b"_s);
    }

    void askForUpdatesSendsOnePrompt()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        f.shell->showView(u"audit"_s);
        f.shell->askForUpdates();
        QCOMPARE(f.shell->view(), u"chat"_s);
        QTRY_COMPARE(f.daemon.requests(u"agent:prompt"_s).size(), 1);
        QCOMPARE(f.daemon.requests(u"agent:prompt"_s).first()["a"].toArray().at(0).toObject().value("text").toString(),
                 u"Update my computer"_s);
    }

    void agentEventsReachTheConversation()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        QVERIFY(f.shell->sendPrompt(u"  what's using my disk?  "_s));
        QTRY_COMPARE(f.daemon.requests(u"agent:prompt"_s).size(), 1);
        QCOMPARE(f.daemon.requests(u"agent:prompt"_s).first()["a"].toArray(),
                 (QJsonArray{QJsonObject{{"text", "what's using my disk?"}}}));
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "turn-start"}, {"turnId", "t1"}, {"text", "what's using my disk?"}});
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "text"}, {"turnId", "t1"}, {"delta", "38% full."}});
        QTRY_COMPARE(f.shell->conversation()->rowCount(), 2);
        QVERIFY(f.shell->conversation()->busy());
    }

    void rejectsEmptyAndOverlongPrompts()
    {
        Fixture f;
        QVERIFY(f.open());
        QVERIFY(!f.shell->sendPrompt(u"   "_s));
        QVERIFY(!f.shell->sendPrompt(QString(8001, u'a')));
        QCOMPARE(f.lastNotice(), u"That message is too long (8000 characters at most)."_s);
        QTest::qWait(50);
        QCOMPARE(f.daemon.requests(u"agent:prompt"_s).size(), 0);
    }

    void decisionIsSentOnceEvenOnDoubleClick()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", card(u"c1"_s, u"t1"_s)}});
        QTRY_VERIFY(f.shell->chatCard()->active());
        QVERIFY(!f.shell->doctorCard()->active());
        f.shell->decide(f.shell->chatCard(), true);
        f.shell->decide(f.shell->chatCard(), true);
        QTRY_COMPARE(f.daemon.requests(u"agent:confirm"_s).size(), 1);
        QTest::qWait(100);
        QCOMPARE(f.daemon.requests(u"agent:confirm"_s).size(), 1);
        const QJsonObject payload = f.daemon.requests(u"agent:confirm"_s).first()["a"].toArray().first().toObject();
        QCOMPARE(payload, (QJsonObject{{"cardId", "c1"}, {"approve", true}, {"ticked", QJsonArray{"i1"}}, {"secrets", QJsonObject{}}}));
        QVERIFY(!f.shell->chatCard()->active());
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "approved"}});
        QTRY_COMPARE(f.lastNotice(), u"Approved."_s);
    }

    void timeoutClosesTheCardWithANotice()
    {
        Fixture f;
        QVERIFY(f.open());
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", card(u"c2"_s, u"t1"_s)}});
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c2"}, {"decision", "timeout"}});
        QTRY_VERIFY(!f.shell->chatCard()->active());
        QCOMPARE(f.lastNotice(), u"No answer in 5 minutes. Nothing was changed."_s);
    }

    void doctorCardsGoToTheDoctor()
    {
        Fixture f;
        QVERIFY(f.open());
        f.shell->openDoctor();
        QCOMPARE(f.shell->view(), u"doctor"_s);
        QTRY_COMPARE(f.daemon.requests(u"doctor:start"_s).size(), 1);
        QTRY_VERIFY(f.shell->doctor()->active());
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", card(u"d1"_s, QJsonValue::Null)}});
        QTRY_VERIFY(f.shell->doctorCard()->active());
        QVERIFY(!f.shell->chatCard()->active());
        f.shell->decide(f.shell->doctorCard(), false);
        QTRY_COMPARE(f.daemon.requests(u"agent:confirm"_s).size(), 1);
        f.shell->doctor()->skip(u"connection"_s);
        QTRY_COMPARE(f.daemon.requests(u"doctor:skip"_s).size(), 1);
        QCOMPARE(f.daemon.requests(u"doctor:skip"_s).first()["a"].toArray(),
                 (QJsonArray{QJsonObject{{"stepId", "connection"}}}));
    }

    void doctorFixedReturnsToChat()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        f.shell->openDoctor();
        QTRY_VERIFY(f.shell->doctor()->started());
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", false}, {"error", "offline"}});
        QTRY_VERIFY(!f.shell->providerReachable());
        f.daemon.sendPush(u"doctor:state"_s, QJsonObject{{"active", false}, {"steps", QJsonArray{}}, {"networks", QJsonArray{}}, {"done", "fixed"}});
        QTRY_COMPARE(f.shell->doctor()->done(), u"fixed"_s);
        QCOMPARE(f.shell->view(), u"doctor"_s); // provider still unreachable
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", true}});
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        QCOMPARE(f.lastNotice(), u"Network doctor fixed the connection."_s);
    }

    void providerStatusDrivesTheBanner()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", false}, {"error", "connect ECONNREFUSED"}});
        QTRY_COMPARE(f.shell->bannerText(), u"Can't reach qwen3:8b: connect ECONNREFUSED"_s);
        QVERIFY(!f.shell->offerDoctor()); // no snapshot yet: the network may be fine
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", true}});
        QTRY_COMPARE(f.shell->bannerText(), QString());
    }

    void doctorIsOfferedOnlyWhenOfflineAndUnreachable()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        f.daemon.sendPush(u"sys:snapshot"_s, snapshot(true));
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", false}, {"error", "401"}});
        QTRY_VERIFY(!f.shell->providerReachable());
        QTRY_VERIFY(f.shell->system()->known());
        QVERIFY(!f.shell->offerDoctor()); // online but unreachable: a key/config problem, not the network
        f.daemon.sendPush(u"sys:snapshot"_s, snapshot(false));
        QTRY_VERIFY(f.shell->offerDoctor());
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", true}});
        QTRY_VERIFY(!f.shell->offerDoctor()); // offline but a LAN/local provider still answers
    }

    void threePerAppItemsUntickOneSendsTwo()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        QJsonObject threeApps = card(u"c3"_s, u"t1"_s);
        threeApps["items"] = QJsonArray{installItem(u"vlc"_s, u"Install VLC 3.0.21"_s, u"debian"_s),
                                        installItem(u"gimp"_s, u"Install GIMP 3.0.4"_s, u"debian"_s),
                                        installItem(u"spotify"_s, u"Install Spotify"_s, u"flathub"_s)};
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", threeApps}});
        QTRY_COMPARE(f.shell->chatCard()->itemCount(), 3);
        f.shell->chatCard()->setTicked(1, false);
        f.shell->decide(f.shell->chatCard(), true);
        QTRY_COMPARE(f.daemon.requests(u"agent:confirm"_s).size(), 1);
        const QJsonObject payload = f.daemon.requests(u"agent:confirm"_s).first()["a"].toArray().first().toObject();
        QCOMPARE(payload["ticked"].toArray(), (QJsonArray{"vlc", "spotify"}));
        QCOMPARE(payload["approve"].toBool(), true);
    }

    void rePushedCardsAreDeduplicated()
    {
        Fixture f;
        QVERIFY(f.open());
        QJsonObject twoApps = card(u"c4"_s, u"t1"_s);
        twoApps["items"] = QJsonArray{installItem(u"vlc"_s, u"Install VLC"_s, u"debian"_s),
                                      installItem(u"gimp"_s, u"Install GIMP"_s, u"debian"_s)};
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", twoApps}});
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.shell->chatCard()->setTicked(0, false);
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", twoApps}});
        f.daemon.sendPush(u"sys:snapshot"_s, snapshot(true)); // a later push proves the re-push was handled
        QTRY_VERIFY(f.shell->system()->known());
        QCOMPARE(f.shell->chatCard()->tickedCount(), 1);
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c4"}, {"decision", "denied"}});
        QTRY_VERIFY(!f.shell->chatCard()->active());
        QCOMPARE(f.lastNotice(), u"Denied. Nothing was changed."_s);
    }

    void stopSendsTheActiveTurn()
    {
        Fixture f;
        QVERIFY(f.open());
        f.shell->stop();
        QTest::qWait(50);
        QCOMPARE(f.daemon.requests(u"agent:stop"_s).size(), 0);
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "turn-start"}, {"turnId", "t9"}, {"text", "q"}});
        QTRY_VERIFY(f.shell->conversation()->busy());
        f.shell->stop();
        QTRY_COMPARE(f.daemon.requests(u"agent:stop"_s).size(), 1);
        QCOMPARE(f.daemon.requests(u"agent:stop"_s).first()["a"].toArray(), (QJsonArray{QJsonObject{{"turnId", "t9"}}}));
    }

    void escapeStopsTheTurnAndLeavesTheCard()
    {
        Fixture f;
        QVERIFY(f.open());
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "turn-start"}, {"turnId", "t1"}, {"text", "q"}});
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", card(u"c1"_s, u"t1"_s)}});
        QTRY_VERIFY(f.shell->chatCard()->active());
        QSignalSpy dismissed(f.shell.get(), &ShellController::dismissRequested);
        f.shell->escape();
        QTRY_COMPARE(f.daemon.requests(u"agent:stop"_s).size(), 1);
        QVERIFY(f.shell->chatCard()->active());
        QCOMPARE(f.daemon.requests(u"agent:confirm"_s).size(), 0);
        QCOMPARE(dismissed.size(), 0);
    }

    void escapeLeavesSecondaryViewsThenDismisses()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        QSignalSpy dismissed(f.shell.get(), &ShellController::dismissRequested);
        f.shell->showView(u"audit"_s);
        QCOMPARE(f.shell->view(), u"audit"_s);
        f.shell->escape();
        QCOMPARE(f.shell->view(), u"chat"_s);
        f.shell->escape();
        QCOMPARE(dismissed.size(), 1);
    }

    void reconnectInterruptsTheTurnAndRestoresTheCard()
    {
        Fixture f;
        f.providerList["active"] = activeProvider();
        QVERIFY(f.open());
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "turn-start"}, {"turnId", "t1"}, {"text", "q"}});
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", card(u"c1"_s, u"t1"_s)}});
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.daemon.dropClients();
        QTRY_COMPARE(f.shell->connection(), u"reconnecting"_s);
        QVERIFY(!f.shell->chatCard()->active());
        QVERIFY(!f.shell->conversation()->busy());
        QCOMPARE(f.lastNotice(), u"Lost the connection to Jarvis. Open approval cards come back when it reconnects; an unanswered card counts as Deny."_s);
        QTRY_COMPARE_WITH_TIMEOUT(f.shell->connection(), u"open"_s, 3000);
        QTRY_COMPARE(f.daemon.requests(u"provider:list"_s).size(), 2);
        // jarvisd re-pushes every open card on the new connection (§6.7), possibly more than once.
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", card(u"c1"_s, u"t1"_s)}});
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card"}, {"card", card(u"c1"_s, u"t1"_s)}});
        QTRY_VERIFY(f.shell->chatCard()->active());
        QCOMPARE(f.shell->chatCard()->cardId(), u"c1"_s);
        f.daemon.sendPush(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "approved"}});
        QTRY_COMPARE(f.lastNotice(), u"Approved."_s);
        int approvedNotices = 0;
        for (int row = 0; row < f.shell->conversation()->rowCount(); ++row)
            approvedNotices += f.shell->conversation()->get(row).value(u"text"_s).toString() == u"Approved." ? 1 : 0;
        QCOMPARE(approvedNotices, 1);
    }

    void openTerminalLaunchesFoot()
    {
        Fixture f;
        QSignalSpy dismissed(f.shell.get(), &ShellController::dismissRequested);
        f.shell->openTerminal();
        QCOMPARE(f.launched, QStringList{u"foot"_s});
        QCOMPARE(dismissed.size(), 1);
        f.launchWorks = false;
        f.shell->openTerminal();
        QCOMPARE(dismissed.size(), 1);
        QCOMPARE(f.lastNotice(), u"Couldn't open a terminal: foot is not installed."_s);
    }

    void savingAProviderReturnsToChat()
    {
        Fixture f;
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"setup"_s);
        f.daemon.handler = [](const QString& channel, const QJsonArray&, quint64) -> FakeDaemon::Reply {
            if (channel == u"provider:probe")
                return {true, okProbe()};
            if (channel == u"provider:save")
                return {true, QJsonObject{{"ok", true}, {"results", QJsonObject{{"local", okProbe()}}}}};
            if (channel == u"provider:list")
                return {true, newShapeList()};
            return {true, QJsonArray{}};
        };
        ProviderModel* provider = f.shell->provider();
        provider->setMode(u"local"_s);
        provider->setModel(u"qwen3:8b"_s);
        provider->probe();
        QTRY_COMPARE(provider->probeState(), u"ok"_s);
        provider->save();
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        const QList<QJsonObject> saves = f.daemon.requests(u"provider:save"_s);
        QCOMPARE(saves.size(), 1);
        QCOMPARE(saves.first()["a"].toArray(), (QJsonArray{QJsonObject{
            {"providers", QJsonArray{QJsonObject{{"kind", "ollama"}, {"baseUrl", "http://localhost:11434"}, {"model", "qwen3:8b"}, {"id", "local"}}}},
            {"allowCloudFallback", false}}}));
    }

    void savingFromSettingsStaysInSettings()
    {
        Fixture f;
        f.providerList = newShapeList();
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        f.shell->showView(u"settings"_s);
        QTRY_COMPARE(f.daemon.requests(u"provider:list"_s).size(), 2); // on open, and on opening Settings
        auto base = f.daemon.handler;
        f.daemon.handler = [base](const QString& channel, const QJsonArray& a, quint64 id) -> FakeDaemon::Reply {
            if (channel == u"provider:probe")
                return {true, okProbe()};
            if (channel == u"provider:save")
                return {true, QJsonObject{{"ok", true}, {"results", QJsonObject{{"local", okProbe()}, {"work", okProbe()}}}}};
            return base(channel, a, id);
        };
        ProviderModel* provider = f.shell->provider();
        provider->editProvider(f.shell->providers()->config(1));
        provider->setModel(u"claude-b"_s);
        provider->probe();
        QTRY_COMPARE(provider->probeState(), u"ok"_s);
        const int lists = f.daemon.requests(u"provider:list"_s).size();
        provider->save();
        QTRY_COMPARE(f.daemon.requests(u"provider:list"_s).size(), lists + 1);
        QCOMPARE(f.shell->view(), u"settings"_s);
        const QJsonArray sent = f.daemon.requests(u"provider:save"_s).first()["a"].toArray().first().toObject().value("providers").toArray();
        QCOMPARE(sent.size(), 2);
        QCOMPARE(sent.at(1).toObject().value("model").toString(), u"claude-b"_s);
        QVERIFY(!sent.at(1).toObject().contains("apiKey"));
    }

    void fallbackShowsWhichProviderAndWhy()
    {
        Fixture f;
        f.providerList = newShapeList();
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->view(), u"chat"_s);
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", true}, {"activeId", "work"}, {"fallbackReason", "local timed out"}});
        QTRY_COMPARE(f.shell->bannerText(), u"Using claude-sonnet-5-5 · Anthropic — local timed out"_s);
        QCOMPARE(f.shell->provider()->activeModel(), u"claude-sonnet-5-5"_s);
        f.daemon.sendPush(u"provider:status"_s, QJsonObject{{"reachable", true}, {"activeId", "local"}, {"fallbackReason", QJsonValue::Null}});
        QTRY_COMPARE(f.shell->bannerText(), QString());
        QCOMPARE(f.shell->provider()->activeModel(), u"qwen3:8b"_s);
    }

    void reorderingFromSettingsSavesTheWholeList()
    {
        Fixture f;
        f.providerList = newShapeList();
        QVERIFY(f.open());
        QTRY_COMPARE(f.shell->providers()->rowCount(), 2);
        f.shell->providers()->moveDown(0);
        f.shell->providers()->setAllowCloudFallback(true);
        f.shell->providers()->save();
        QTRY_COMPARE(f.daemon.requests(u"provider:save"_s).size(), 1);
        const QJsonObject payload = f.daemon.requests(u"provider:save"_s).first()["a"].toArray().first().toObject();
        QCOMPARE(payload.value("allowCloudFallback").toBool(), true);
        QCOMPARE(payload.value("providers").toArray().first().toObject().value("id").toString(), u"work"_s);
    }

    void checkForUpdatesAppliesTheCounts()
    {
        Fixture f;
        auto base = f.daemon.handler;
        f.daemon.handler = [base](const QString& channel, const QJsonArray& args, quint64 id) -> FakeDaemon::Reply {
            if (channel == u"updates:check")
                return {true, QJsonObject{{"count", 4}, {"security", 2}}};
            return base(channel, args, id);
        };
        QVERIFY(f.open());
        f.shell->checkForUpdates();
        QVERIFY(f.shell->updatesChecking());
        f.shell->checkForUpdates();                         // no second request while one runs
        QTRY_VERIFY(!f.shell->updatesChecking());
        QCOMPARE(f.daemon.requests(u"updates:check"_s).size(), 1);
        QCOMPARE(f.daemon.requests(u"updates:check"_s).at(0).value("a").toArray(), QJsonArray{});
        QCOMPARE(f.shell->system()->updatesCount(), 4);
        QCOMPARE(f.shell->system()->updatesSecurity(), 2);
        QCOMPARE(f.shell->updatesNote(), QString());
    }

    void upToDateIsSaid()
    {
        Fixture f;
        auto base = f.daemon.handler;
        f.daemon.handler = [base](const QString& channel, const QJsonArray& args, quint64 id) -> FakeDaemon::Reply {
            if (channel == u"updates:check")
                return {true, QJsonObject{{"count", 0}, {"security", 0}}};
            return base(channel, args, id);
        };
        QVERIFY(f.open());
        f.shell->checkForUpdates();
        QTRY_COMPARE(f.shell->updatesNote(), u"Everything is up to date."_s);
    }

    void checkErrorsShowTheMessage()
    {
        Fixture f;
        auto base = f.daemon.handler;
        QString code = u"internal"_s, text = u"apt is locked by another program"_s;
        f.daemon.handler = [&, base](const QString& channel, const QJsonArray& args, quint64 id) -> FakeDaemon::Reply {
            if (channel == u"updates:check")
                return {false, {}, code, text};
            return base(channel, args, id);
        };
        QVERIFY(f.open());
        f.shell->checkForUpdates();
        QTRY_COMPARE(f.shell->updatesNote(), u"apt is locked by another program"_s);
        code = u"unsupported"_s;
        text.clear();
        f.shell->checkForUpdates();
        QTRY_COMPARE(f.shell->updatesNote(), u"This system can't check for updates yet."_s);
    }
};

QTEST_GUILESS_MAIN(TestShellController)
#include "tst_shellcontroller.moc"
