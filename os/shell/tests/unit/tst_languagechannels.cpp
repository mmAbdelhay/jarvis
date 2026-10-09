#include <QSignalSpy>
#include <QtTest>

#include "ShellFixture.h"
#include "models/CardModel.h"

using namespace Qt::StringLiterals;

namespace {
struct LanguageRig : ShellFixture {
    QStringList applied;
    bool arabicInstalled = true;
    LanguageRig()
    {
        shell->setLanguageApplier([this](const QString& code) {
            if (code == u"ar" && !arabicInstalled)
                return false;
            applied << code;
            return true;
        }, u"en"_s);
    }
};
} // namespace

class TestLanguageChannels : public QObject {
    Q_OBJECT
private slots:
    void pushAppliesTheLanguage()
    {
        LanguageRig f;
        QVERIFY(f.open());
        QSignalSpy changed(f.shell.get(), &ShellController::languageChanged);
        f.push(u"ui:language"_s, QJsonObject{{"lang", "ar"}});
        QTRY_COMPARE(f.shell->language(), u"ar"_s);
        QCOMPARE(f.applied, QStringList{u"ar"_s});
        QVERIFY(changed.size() >= 1);
        f.push(u"ui:language"_s, QJsonObject{{"lang", "ar"}}); // a re-push is a no-op
        QTest::qWait(100);
        QCOMPARE(f.applied, QStringList{u"ar"_s});
    }

    void unknownLanguagePushIsIgnored()
    {
        LanguageRig f;
        QVERIFY(f.open());
        const QList<QJsonValue> bad{QJsonObject{{"lang", "fr"}}, QJsonObject{{"lang", "ar‮"}},
                                    QJsonObject{{"lang", 7}}, QJsonObject{}, QJsonArray{"ar"},
                                    QJsonObject{{"lang", "AR"}}, QJsonValue(u"ar"_s)};
        for (const QJsonValue& payload : bad)
            f.push(u"ui:language"_s, payload);
        f.push(u"sys:snapshot"_s, fixture::snapshot(false)); // a marker that the pushes above arrived
        QTest::qWait(200);
        QCOMPARE(f.shell->language(), u"en"_s);
        QVERIFY(f.applied.isEmpty());
    }

    void chooseLanguageSendsTheRequest()
    {
        LanguageRig f;
        QVERIFY(f.open());
        f.shell->chooseLanguage(u"ar"_s);
        QVERIFY(f.shell->languageBusy());
        QTRY_COMPARE(f.requests(u"ui:setLanguage"_s).size(), 1);
        QCOMPARE(f.requests(u"ui:setLanguage"_s).first().value("a").toArray(),
                 (QJsonArray{QJsonObject{{"lang", "ar"}}}));
        QTRY_COMPARE(f.shell->language(), u"ar"_s);
        QVERIFY(!f.shell->languageBusy());
        f.shell->chooseLanguage(u"de"_s); // never sent
        QTest::qWait(100);
        QCOMPARE(f.requests(u"ui:setLanguage"_s).size(), 1);
    }

    void requestErrorShowsANote()
    {
        LanguageRig f;
        f.replies.insert(u"ui:setLanguage"_s, {false, {}, u"unsupported"_s, u"unknown channel"_s});
        QVERIFY(f.open());
        f.shell->chooseLanguage(u"ar"_s);
        QTRY_COMPARE(f.shell->languageNote(), u"This version of Jarvis can't change the language yet."_s);
        QCOMPARE(f.shell->language(), u"en"_s);
        f.replies.insert(u"ui:setLanguage"_s, {false, {}, u"internal"_s, u"disk full"_s});
        f.shell->chooseLanguage(u"ar"_s);
        QTRY_COMPARE(f.shell->languageNote(), u"Couldn't change the language: disk full"_s);
    }

    void settingsShowsWhyArabicIsUnavailable()
    {
        LanguageRig f;
        f.arabicInstalled = false;
        QVERIFY(f.open());
        f.push(u"ui:language"_s, QJsonObject{{"lang", "ar"}});
        QTRY_COMPARE(f.shell->languageNote(), u"Arabic isn't installed on this computer, so Jarvis stays in English."_s);
        QCOMPARE(f.shell->language(), u"en"_s);
    }

    void languageSwitchKeepsTheOpenCard()
    {
        LanguageRig f;
        QVERIFY(f.open());
        f.push(u"agent:events"_s, QJsonObject{{"type", "turn-start"}, {"turnId", "t1"}, {"text", "brighter"}});
        f.push(u"agent:events"_s, QJsonObject{{"type", "text"}, {"turnId", "t1"}, {"delta", "Hel"}});
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s), fixture::item(u"b"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        const int rows = f.shell->conversation()->rowCount();

        f.push(u"ui:language"_s, QJsonObject{{"lang", "ar"}});
        QTRY_COMPARE(f.shell->language(), u"ar"_s);
        f.push(u"agent:events"_s, QJsonObject{{"type", "text"}, {"turnId", "t1"}, {"delta", "lo"}});
        QTRY_COMPARE(f.lastNotice(), u"Hello"_s);

        QVERIFY(f.shell->chatCard()->active());
        QCOMPARE(f.shell->chatCard()->cardId(), u"c1"_s);
        QCOMPARE(f.shell->conversation()->rowCount(), rows);
        f.shell->decide(f.shell->chatCard(), true);
        QTRY_COMPARE(f.requests(u"agent:confirm"_s).size(), 1);
        QCOMPARE(f.requests(u"agent:confirm"_s).first().value("a").toArray().at(0).toObject().value("cardId").toString(),
                 u"c1"_s);
    }
};

QTEST_MAIN(TestLanguageChannels)
#include "tst_languagechannels.moc"
