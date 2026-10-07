// Drives a real jarvisd (Plan A) through the C++ control client, with the
// fake provider of contracts §5 so no model is involved. Skips unless
// JARVISD_ENTRY points at the built jarvisd CLI script. The card test also
// needs Plan B's MCP servers (JARVIS_MCP_DIR) and only ever DENIES the card,
// so nothing on the CI machine changes.
#include <QEventLoop>
#include <QJsonArray>
#include <QJsonDocument>
#include <QProcess>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtTest>
#include <memory>

#include "control/ControlClient.h"
#include "protocol/BuildId.h"
#include "protocol/ControlPaths.h"

using namespace Qt::StringLiterals;

namespace {
ControlResult call(ControlClient& client, const QString& channel, const QJsonArray& args)
{
    std::optional<ControlResult> out;
    QEventLoop loop;
    QTimer::singleShot(15000, &loop, &QEventLoop::quit);
    client.invoke(channel, args, [&](const ControlResult& r) {
        out = r;
        loop.quit();
    });
    if (!out)
        loop.exec();
    return out.value_or(ControlResult{false, {}, u"timeout"_s, u"no reply within 15 s"_s});
}

// Waits for an agent:events push matching `pred`, appending every event seen
// to `seen`. `cursor` remembers how far into `pushes` earlier calls have read.
bool waitForEvent(QSignalSpy& pushes, qsizetype& cursor, QList<QJsonObject>& seen,
                  const std::function<bool(const QJsonObject&)>& pred, int timeoutMs = 20000)
{
    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < timeoutMs) {
        while (cursor < pushes.size()) {
            const QList<QVariant> args = pushes.at(cursor++);
            if (args.at(0).toString() != u"agent:events")
                continue;
            const QJsonObject event = args.at(1).value<QJsonValue>().toObject();
            seen.append(event);
            if (pred(event))
                return true;
        }
        pushes.wait(200);
    }
    return false;
}
} // namespace

class TestIntegration : public QObject {
    Q_OBJECT
private slots:
    void initTestCase()
    {
        m_entry = qEnvironmentVariable("JARVISD_ENTRY");
        if (m_entry.isEmpty())
            QSKIP("JARVISD_ENTRY is not set: build jarvisd and point it at the jarvisd CLI script");
        QVERIFY(m_home.isValid());
        const QJsonArray script{
            QJsonObject{{"expectPromptContains", "hello"},
                        {"replies", QJsonArray{QJsonObject{{"text", "Hi from the fake provider."}}}}},
            QJsonObject{{"expectPromptContains", "radio"},
                        {"replies", QJsonArray{QJsonObject{{"toolCalls", QJsonArray{QJsonObject{{"name", "net.radio_on"}, {"input", QJsonObject{}}}}}},
                                               QJsonObject{{"text", "Left the radio alone."}}}}}};
        QFile file(m_home.filePath(u"fake-provider.json"_s));
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write(QJsonDocument(script).toJson());
        file.close();

        QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
        env.insert(u"HOME"_s, m_home.path());
        env.insert(u"XDG_CONFIG_HOME"_s, m_home.filePath(u".config"_s));
        env.insert(u"XDG_STATE_HOME"_s, m_home.filePath(u".local/state"_s));
        env.insert(u"JARVIS_FAKE_PROVIDER"_s, file.fileName());
        m_daemon.setProcessEnvironment(env);
        m_daemon.setProcessChannelMode(QProcess::ForwardedChannels);
        m_daemon.start(qEnvironmentVariable("NODE", u"node"_s), {m_entry, u"run"_s});
        QVERIFY2(m_daemon.waitForStarted(10000), qPrintable(m_daemon.errorString()));

        // The shell's starting build is deliberately wrong: it must adopt the
        // daemon's build from restart-required (Task 4) and still connect.
        const auto paths = jarvis::protocol::controlPaths(m_home.filePath(u".config/jarvis/run"_s));
        ControlOptions options;
        options.socketPath = paths.socketPath;
        options.secretPath = paths.secretPath;
        options.build = u"not-the-daemon-build"_s;
        options.backoffMs = {100, 250, 500};
        m_client = std::make_unique<ControlClient>(options);
        QSignalSpy opened(m_client.get(), &ControlClient::opened);
        m_client->start();
        QVERIFY2(opened.wait(30000) || m_client->state() == ControlClient::State::Open, qPrintable(m_client->lastError()));
    }

    void adoptedTheDaemonBuild()
    {
        QVERIFY(m_client->build() != u"not-the-daemon-build"_s);
    }

    // Contracts §6.6: the stamp beside the bundle names the daemon's build, so
    // a client started from it is welcomed on the first hello.
    void stampedBuildMatchesTheDaemon()
    {
        const QString stamp = QFileInfo(m_entry).dir().filePath(u"build-stamp.json"_s);
        if (!QFile::exists(stamp))
            QSKIP("no build-stamp.json beside JARVISD_ENTRY");
        QCOMPARE(jarvis::protocol::readBuildId(stamp), m_client->build());
    }

    void providerListHasTheThreeKinds()
    {
        const ControlResult r = call(*m_client, u"provider:list"_s, {});
        QVERIFY2(r.ok, qPrintable(r.text));
        QCOMPARE(r.value.toObject()["kinds"].toArray(), (QJsonArray{"anthropic", "openai-compatible", "ollama"}));
    }

    void promptStreamsTheFakeReply()
    {
        QSignalSpy pushes(m_client.get(), &ControlClient::push);
        const ControlResult r = call(*m_client, u"agent:prompt"_s, {QJsonObject{{"text", "hello there"}}});
        QVERIFY2(r.ok, qPrintable(r.text));
        const QString turnId = r.value.toObject()["turnId"].toString();
        QVERIFY(!turnId.isEmpty());
        QList<QJsonObject> seen;
        qsizetype cursor = 0;
        QVERIFY(waitForEvent(pushes, cursor, seen, [&](const QJsonObject& e) {
            return e["type"].toString() == u"turn-end" && e["turnId"].toString() == turnId;
        }));
        QString text;
        bool started = false;
        for (const QJsonObject& e : seen) {
            if (e["turnId"].toString() != turnId)
                continue;
            if (e["type"].toString() == u"turn-start") {
                started = true;
                QCOMPARE(e["text"].toString(), u"hello there"_s);
            }
            if (e["type"].toString() == u"text")
                text += e["delta"].toString();
            if (e["type"].toString() == u"turn-end")
                QCOMPARE(e["reason"].toString(), u"done"_s);
        }
        QVERIFY(started);
        QCOMPARE(text, u"Hi from the fake provider."_s);
    }

    void denyingACardChangesNothing()
    {
        if (qEnvironmentVariableIsEmpty("JARVIS_MCP_DIR"))
            QSKIP("JARVIS_MCP_DIR is not set: the confirm-card path needs Plan B's MCP servers");
        QSignalSpy pushes(m_client.get(), &ControlClient::push);
        const ControlResult r = call(*m_client, u"agent:prompt"_s, {QJsonObject{{"text", "radio check"}}});
        QVERIFY2(r.ok, qPrintable(r.text));
        QList<QJsonObject> seen;
        qsizetype cursor = 0;
        QVERIFY(waitForEvent(pushes, cursor, seen, [](const QJsonObject& e) { return e["type"].toString() == u"card"; }));
        const QJsonObject card = seen.last()["card"].toObject();
        QCOMPARE(card["items"].toArray().first().toObject()["tool"].toString(), u"net.radio_on"_s);
        const QString cardId = card["cardId"].toString();
        const ControlResult confirm = call(*m_client, u"agent:confirm"_s,
                                           {QJsonObject{{"cardId", cardId}, {"approve", false}, {"ticked", QJsonArray{}}, {"secrets", QJsonObject{}}}});
        QVERIFY2(confirm.ok, qPrintable(confirm.text));
        QVERIFY(waitForEvent(pushes, cursor, seen, [&](const QJsonObject& e) {
            return e["type"].toString() == u"card-closed" && e["cardId"].toString() == cardId;
        }));
        QCOMPARE(seen.last()["decision"].toString(), u"denied"_s);
        QVERIFY(waitForEvent(pushes, cursor, seen, [](const QJsonObject& e) { return e["type"].toString() == u"turn-end"; }));
        const ControlResult audit = call(*m_client, u"audit:list"_s, {QJsonObject{{"limit", 5}}});
        QVERIFY2(audit.ok, qPrintable(audit.text));
        const QJsonObject newest = audit.value.toArray().first().toObject();
        QCOMPARE(newest["tool"].toString(), u"net.radio_on"_s);
        QCOMPARE(newest["decision"].toString(), u"denied"_s);
    }

    void cleanupTestCase()
    {
        m_client.reset();
        if (m_daemon.state() != QProcess::NotRunning) {
            m_daemon.terminate();
            if (!m_daemon.waitForFinished(10000))
                m_daemon.kill();
        }
    }

private:
    QString m_entry;
    QTemporaryDir m_home{u"/tmp/jsh-home-XXXXXX"_s}; // short: the socket path must fit sun_path
    QProcess m_daemon;
    std::unique_ptr<ControlClient> m_client;
};

QTEST_GUILESS_MAIN(TestIntegration)
#include "tst_integration.moc"
