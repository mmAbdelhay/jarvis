#include <QSignalSpy>
#include <QtTest>

#include "Language.h"
#include "models/CuSessionModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject running(int step = 3)
{
    return {{"active", true}, {"sessionId", "s1"}, {"goal", "Export beach.xcf as PNG to Pictures"},
            {"apps", QJsonArray{"GIMP"}}, {"step", step}, {"maxSteps", 50},
            {"steps", QJsonArray{QJsonObject{{"title", "Open the File menu"}, {"status", "done"}},
                                 QJsonObject{{"title", "Choose Export As"}, {"status", "running"}},
                                 QJsonObject{{"title", "Save"}, {"status", "pending"}}}},
            {"paused", QJsonValue::Null}};
}

QJsonObject paused(const QString& reason)
{
    QJsonObject s = running();
    s["paused"] = reason;
    return s;
}
} // namespace

class TestCuSession : public QObject {
    Q_OBJECT
private slots:
    void inactiveByDefault()
    {
        CuSessionModel m;
        QVERIFY(!m.active());
        QVERIFY(!m.visible());
        QVERIFY(!m.running());
        QCOMPARE(m.rowCount(), 0);
    }

    void activePushFillsTheModel()
    {
        CuSessionModel m;
        QSignalSpy running(&m, &CuSessionModel::runningChanged);
        m.applyState(::running());
        QVERIFY(m.active());
        QVERIFY(m.visible());
        QVERIFY(m.running());
        QCOMPARE(running.size(), 1);
        QCOMPARE(m.sessionId(), u"s1"_s);
        QCOMPARE(m.goal(), u"Export beach.xcf as PNG to Pictures"_s);
        QCOMPARE(m.apps(), QStringList{u"GIMP"_s});
        QCOMPARE(m.step(), 3);
        QCOMPARE(m.maxSteps(), 50);
        QCOMPARE(m.statusText(), u"Jarvis is controlling the screen · step 3 of 50"_s);
        QCOMPARE(m.rowCount(), 3);
        QCOMPARE(m.data(m.index(1), CuSessionModel::TitleRole).toString(), u"Choose Export As"_s);
        QCOMPARE(m.data(m.index(1), CuSessionModel::StatusRole).toString(), u"running"_s);
        QCOMPARE(m.data(m.index(0), CuSessionModel::StatusLabelRole).toString(), u"Done"_s);
        QCOMPARE(m.data(m.index(2), CuSessionModel::StatusLabelRole).toString(), u"Waiting"_s);
        m.applyState(::running(4)); // still running: no second runningChanged
        QCOMPARE(running.size(), 1);
        QCOMPARE(m.step(), 4);
    }

    void pausedReasons_data()
    {
        QTest::addColumn<QString>("reason");
        QTest::addColumn<QString>("detail");
        QTest::newRow("physical") << u"physical-input"_s << u"You moved the mouse or typed."_s;
        QTest::newRow("esc") << u"esc"_s << u"You pressed Esc."_s;
        QTest::newRow("excluded") << u"excluded-focus"_s << u"A protected window has focus."_s;
        QTest::newRow("locked") << u"locked"_s << u"The screen locked."_s;
        QTest::newRow("unknown") << u"card"_s << u"Jarvis paused."_s;
    }

    void pausedReasons()
    {
        QFETCH(QString, reason);
        QFETCH(QString, detail);
        CuSessionModel m;
        m.applyState(paused(reason));
        QVERIFY(m.paused());
        QVERIFY(!m.running());
        QCOMPARE(m.pauseReason(), reason);
        QCOMPARE(m.statusText(), u"Paused · you have control"_s);
        QCOMPARE(m.detailText(), detail);
    }

    void malformedPushesAreIgnored()
    {
        CuSessionModel m;
        m.applyState(running());
        m.applyState(QJsonObject{});
        m.applyState(QJsonObject{{"active", "no"}});
        m.applyState(QJsonObject{{"active", 0}});
        QVERIFY(m.active());
        QCOMPARE(m.goal(), u"Export beach.xcf as PNG to Pictures"_s);
        QJsonObject odd = running();
        odd["paused"] = QJsonObject{{"why", "x"}}; // not null, not a string: still paused
        m.applyState(odd);
        QVERIFY(m.paused());
        QCOMPARE(m.detailText(), u"Jarvis paused."_s);
    }

    void untrustedTextIsCleaned()
    {
        CuSessionModel m;
        QJsonObject s = running();
        s["goal"] = u"Rename to ‮gnp.exe‬\nnow⁦x⁩"_s;
        QJsonArray apps;
        for (int i = 0; i < 12; ++i)
            apps.append(u"App%1"_s.arg(i));
        apps.append(QString(200, u'a'));
        s["apps"] = apps;
        QJsonArray steps;
        for (int i = 0; i < 150; ++i)
            steps.append(QJsonObject{{"title", u"s%1"_s.arg(i)}, {"status", i == 0 ? "hacked" : "done"}});
        steps.append(QJsonObject{{"title", QString(500, u'x')}, {"status", "failed"}});
        s["steps"] = steps;
        m.applyState(s);
        QCOMPARE(m.goal(), u"Rename to gnp.exe nowx"_s);
        QCOMPARE(m.apps().size(), 8);
        QCOMPARE(m.rowCount(), 100);
        QCOMPARE(m.data(m.index(98), CuSessionModel::TitleRole).toString(), u"s149"_s);
        const QString longTitle = m.data(m.index(99), CuSessionModel::TitleRole).toString();
        QCOMPARE(longTitle.size(), 160);
        QVERIFY(longTitle.endsWith(u'…'));
        QCOMPARE(CuSessionModel::cleanText(u"<b>bold</b>\t\tok"_s, 50), u"<b>bold</b> ok"_s);
        QCOMPARE(CuSessionModel::cleanText(QString(), 10), QString());
    }

    void supplementaryFormatCharactersAreRemoved()
    {
        // U+E0001 LANGUAGE TAG is Cf even though UTF-16 uses two code units.
        const char32_t raw[] = U"before\U000E0001after";
        QCOMPARE(CuSessionModel::cleanText(QString::fromUcs4(raw), 64), u"beforeafter"_s);
    }

    void textBoundsDoNotSplitSurrogates()
    {
        const char32_t raw[] = U"a\U0001F600bc";
        QCOMPARE(CuSessionModel::cleanText(QString::fromUcs4(raw), 3), u"a…"_s);
        QCOMPARE(CuSessionModel::cleanText(u"abc"_s, 1), u"…"_s);
        QCOMPARE(CuSessionModel::cleanText(u"abc"_s, 0), QString());
    }

    void unknownStatusIsPending()
    {
        CuSessionModel m;
        QJsonObject s = running();
        s["steps"] = QJsonArray{QJsonObject{{"title", "x"}, {"status", "hacked"}}, QJsonObject{{"title", "y"}}};
        m.applyState(s);
        QCOMPARE(m.data(m.index(0), CuSessionModel::StatusRole).toString(), u"pending"_s);
        QCOMPARE(m.data(m.index(1), CuSessionModel::StatusRole).toString(), u"pending"_s);
    }

    void maxStepsIsCapped()
    {
        CuSessionModel m;
        QJsonObject s = running();
        s["maxSteps"] = 1000;
        s["step"] = 999;
        m.applyState(s);
        QCOMPARE(m.maxSteps(), 50);
        QCOMPARE(m.step(), 50);
        s["maxSteps"] = 0;
        s["step"] = -4;
        m.applyState(s);
        QCOMPARE(m.maxSteps(), 50);
        QCOMPARE(m.step(), 0);
        s["maxSteps"] = 20;
        s["step"] = 7;
        m.applyState(s);
        QCOMPARE(m.maxSteps(), 20);
        QCOMPARE(m.statusText(), u"Jarvis is controlling the screen · step 7 of 20"_s);
    }

    void stopAndResumeGuards()
    {
        CuSessionModel m;
        QSignalSpy stops(&m, &CuSessionModel::stopRequested);
        QSignalSpy resumes(&m, &CuSessionModel::resumeRequested);
        m.stop(); // nothing to stop
        QCOMPARE(stops.size(), 0);
        m.applyState(running());
        m.resume(); // not paused
        QCOMPARE(resumes.size(), 0);
        m.stop();
        QCOMPARE(stops.size(), 1);
        QVERIFY(m.busy());
        m.stop(); // a double click sends once
        QCOMPARE(stops.size(), 1);
        m.applyRequestResult(false, u"closed"_s);
        QVERIFY(!m.busy());
        QCOMPARE(m.error(), u"Couldn't stop Jarvis: closed"_s);
        m.applyState(paused(u"esc"_s));
        m.resume();
        QCOMPARE(resumes.size(), 1);
        m.applyRequestResult(false, u"no-session"_s);
        QCOMPARE(m.error(), u"Couldn't resume: no-session"_s);
        m.applyRequestResult(true, {}); // a stray answer changes nothing
        QCOMPARE(m.error(), u"Couldn't resume: no-session"_s);
    }

    void connectionLossKeepsTheOverlayThenClears()
    {
        CuSessionModel m;
        m.applyState(running());
        QSignalSpy running(&m, &CuSessionModel::runningChanged);
        m.connectionClosed();
        QVERIFY(m.visible());
        QVERIFY(m.connectionLost());
        QVERIFY(!m.running());
        QCOMPARE(running.size(), 1);
        QCOMPARE(m.statusText(), u"Lost the connection to Jarvis. Reconnecting…"_s);
        QSignalSpy stops(&m, &CuSessionModel::stopRequested);
        m.stop();
        m.resume();
        QCOMPARE(stops.size(), 0);
        m.connectionOpened();
        QVERIFY(!m.visible());
        QVERIFY(!m.active());
        QCOMPARE(m.rowCount(), 0);
        m.connectionOpened(); // idempotent
        QVERIFY(!m.visible());
    }

    void inactivePushClears()
    {
        CuSessionModel m;
        m.applyState(running());
        m.applyState(QJsonObject{{"active", false}});
        QVERIFY(!m.active());
        QVERIFY(!m.visible());
        QCOMPARE(m.goal(), QString());
        QCOMPARE(m.rowCount(), 0);
    }

    void arabicTexts()
    {
        qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR);
        jarvis::ui::LanguageManager language({u"jarvis-ui"_s, u"jarvis-shell"_s});
        QVERIFY(language.setLanguage(u"ar"_s));
        CuSessionModel m;
        m.applyState(running(2));
        QCOMPARE(m.statusText(), u"جارفيس يتحكم في الشاشة · الخطوة 2 من 50"_s);
        QCOMPARE(m.data(m.index(1), CuSessionModel::StatusLabelRole).toString(), u"قيد التنفيذ"_s);
        m.applyState(paused(u"physical-input"_s));
        QCOMPARE(m.statusText(), u"متوقف مؤقتًا · التحكم لك"_s);
        QCOMPARE(m.detailText(), u"حرّكت الفأرة أو كتبت."_s);
        QJsonObject two = running();
        two["apps"] = QJsonArray{"GIMP", "Firefox"};
        m.applyState(two);
        QCOMPARE(m.appsText(), u"GIMP، Firefox"_s);
        QVERIFY(language.setLanguage(u"en"_s));
        QCOMPARE(m.appsText(), u"GIMP, Firefox"_s);
    }
};

QTEST_GUILESS_MAIN(TestCuSession)
#include "tst_cusession.moc"
