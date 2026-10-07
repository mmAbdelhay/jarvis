#include <QAbstractItemModelTester>
#include <QSignalSpy>
#include <QtTest>

#include "models/Conversation.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject textEvent(const QString& turnId, const QString& delta)
{
    return {{"type", "text"}, {"turnId", turnId}, {"delta", delta}};
}
QJsonObject toolEvent(const QString& callId, const QString& status, const QString& summary)
{
    return {{"type", "tool"}, {"turnId", "t1"}, {"callId", callId}, {"name", "net.status"},
            {"status", status}, {"summary", summary}};
}
} // namespace

class TestConversation : public QObject {
    Q_OBJECT
private slots:
    void streamsDeltasIntoOneAssistantRow()
    {
        Conversation model;
        QAbstractItemModelTester tester(&model);
        model.applyEvent({{"type", "turn-start"}, {"turnId", "t1"}, {"text", "what's using my disk?"}});
        model.applyEvent(textEvent(u"t1"_s, u"Your disk "_s));
        model.applyEvent(textEvent(u"t1"_s, u"is 38% full."_s));
        QCOMPARE(model.rowCount(), 2);
        QCOMPARE(model.get(0)["kind"].toString(), u"user"_s);
        QCOMPARE(model.get(0)["text"].toString(), u"what's using my disk?"_s);
        QCOMPARE(model.get(1)["kind"].toString(), u"assistant"_s);
        QCOMPARE(model.get(1)["text"].toString(), u"Your disk is 38% full."_s);
        QVERIFY(model.busy());
        QCOMPARE(model.activeTurnId(), u"t1"_s);
    }

    void manyDeltasStayOneRow()
    {
        Conversation model;
        model.applyEvent({{"type", "turn-start"}, {"turnId", "t1"}, {"text", "hi"}});
        for (int i = 0; i < 5000; ++i)
            model.applyEvent(textEvent(u"t1"_s, u"x"_s));
        QCOMPARE(model.rowCount(), 2);
        QCOMPARE(model.get(1)["text"].toString().size(), 5000);
    }

    void toolLinesUpdateInPlace()
    {
        Conversation model;
        QAbstractItemModelTester tester(&model);
        model.applyEvent({{"type", "turn-start"}, {"turnId", "t1"}, {"text", "my internet isn't working"}});
        model.applyEvent(toolEvent(u"c1"_s, u"running"_s, u""_s));
        model.applyEvent(toolEvent(u"c2"_s, u"running"_s, u""_s));
        model.applyEvent(toolEvent(u"c1"_s, u"ok"_s, u"wlp2s0 disconnected · NetworkManager inactive"_s));
        QCOMPARE(model.rowCount(), 3);
        QCOMPARE(model.get(1)["toolStatus"].toString(), u"ok"_s);
        QCOMPARE(model.get(1)["toolName"].toString(), u"net.status"_s);
        QCOMPARE(model.get(1)["text"].toString(), u"wlp2s0 disconnected · NetworkManager inactive"_s);
        QCOMPARE(model.get(2)["toolStatus"].toString(), u"running"_s);
    }

    void textAfterAToolLineStartsANewRow()
    {
        Conversation model;
        model.applyEvent({{"type", "turn-start"}, {"turnId", "t1"}, {"text", "q"}});
        model.applyEvent(textEvent(u"t1"_s, u"Checking."_s));
        model.applyEvent(toolEvent(u"c1"_s, u"ok"_s, u"done"_s));
        model.applyEvent(textEvent(u"t1"_s, u"NetworkManager crashed."_s));
        QCOMPARE(model.rowCount(), 4);
        QCOMPARE(model.get(3)["text"].toString(), u"NetworkManager crashed."_s);
    }

    void turnEndReasons_data()
    {
        QTest::addColumn<QString>("reason");
        QTest::addColumn<QString>("error");
        QTest::addColumn<QString>("notice");
        QTest::newRow("done") << u"done"_s << QString() << QString();
        QTest::newRow("stopped") << u"stopped"_s << QString() << u"Stopped."_s;
        QTest::newRow("step-limit") << u"step-limit"_s << QString()
                                    << u"Stopped after 20 steps. The messages above say what was done and what is left."_s;
        QTest::newRow("error") << u"error"_s << u"provider timeout"_s << u"Something went wrong: provider timeout"_s;
    }

    void turnEndReasons()
    {
        QFETCH(QString, reason);
        QFETCH(QString, error);
        QFETCH(QString, notice);
        Conversation model;
        QSignalSpy turns(&model, &Conversation::activeTurnChanged);
        model.applyEvent({{"type", "turn-start"}, {"turnId", "t1"}, {"text", "q"}});
        QJsonObject end{{"type", "turn-end"}, {"turnId", "t1"}, {"reason", reason}};
        if (!error.isEmpty())
            end.insert("error", error);
        model.applyEvent(end);
        QVERIFY(!model.busy());
        QCOMPARE(turns.size(), 2);
        if (notice.isEmpty()) {
            QCOMPARE(model.rowCount(), 1);
        } else {
            QCOMPARE(model.get(model.rowCount() - 1)["kind"].toString(), u"notice"_s);
            QCOMPARE(model.get(model.rowCount() - 1)["text"].toString(), notice);
        }
    }

    void ignoresUnknownAndMalformedEvents()
    {
        Conversation model;
        model.applyEvent({{"type", "card"}, {"card", QJsonObject{}}});
        model.applyEvent({{"type", "nonsense"}});
        model.applyEvent(textEvent(u"t1"_s, u""_s));
        model.applyEvent({{"type", "tool"}, {"callId", ""}, {"status", "ok"}});
        model.applyEvent({{"type", "tool"}, {"callId", "c9"}, {"status", "exploded"}});
        QCOMPARE(model.rowCount(), 0);
    }

    void markInterruptedEndsTheTurn()
    {
        Conversation model;
        model.markInterrupted();
        QCOMPARE(model.rowCount(), 0); // nothing running: nothing to say
        model.applyEvent({{"type", "turn-start"}, {"turnId", "t1"}, {"text", "q"}});
        model.markInterrupted();
        QVERIFY(!model.busy());
        QCOMPARE(model.get(1)["text"].toString(), u"Lost the connection to Jarvis during this answer."_s);
    }
};

QTEST_GUILESS_MAIN(TestConversation)
#include "tst_conversation.moc"
