#include <QAbstractItemModelTester>
#include <QJsonArray>
#include <QtTest>

#include "models/CardModel.h"
#include "models/Conversation.h"
#include "models/SettingChange.h"

using namespace Qt::StringLiterals;

class TestSettingChange : public QObject {
    Q_OBJECT
private slots:
    void parsesSettingsChanges_data()
    {
        QTest::addColumn<QString>("tool");
        QTest::addColumn<QString>("text");
        QTest::addColumn<QString>("from");
        QTest::addColumn<QString>("to");
        QTest::newRow("brightness") << u"settings.brightness"_s << u"40% → 70%"_s << u"40%"_s << u"70%"_s;
        QTest::newRow("model name") << u"settings_volume"_s << u" 30% → muted "_s << u"30%"_s << u"muted"_s;
        QTest::newRow("not settings") << u"pkg.install"_s << u"1.0 → 1.1"_s << QString() << QString();
        QTest::newRow("no arrow") << u"settings.wifi"_s << u"Turn Wi-Fi off"_s << QString() << QString();
        QTest::newRow("two arrows") << u"settings.scale"_s << u"1 → 1.5 → 2"_s << QString() << QString();
        QTest::newRow("empty side") << u"settings.scale"_s << u" → 2"_s << QString() << QString();
        QTest::newRow("multi-line") << u"settings.keyboard"_s << u"us\nfr → ara"_s << QString() << QString();
        QTest::newRow("edge newline") << u"settings.keyboard"_s << u"\nus → ara"_s << QString() << QString();
        QTest::newRow("carriage return") << u"settings.keyboard"_s << u"us\rfr → ara"_s << QString() << QString();
        QTest::newRow("current too long") << u"settings.keyboard"_s << u"us → "_s + QString(81, u'x') << QString() << QString();
        QTest::newRow("limit") << u"settings.keyboard"_s << QString(80, u'x') + u" → ara"_s << QString(80, u'x') << u"ara"_s;
        QTest::newRow("too long") << u"settings.keyboard"_s << QString(81, u'x') + u" → ara"_s << QString() << QString();
    }
    void parsesSettingsChanges()
    {
        QFETCH(QString, tool);
        QFETCH(QString, text);
        QFETCH(QString, from);
        QFETCH(QString, to);
        const auto change = settingChange(tool, text);
        QCOMPARE(change.has_value(), !from.isEmpty());
        if (change) {
            QCOMPARE(change->first, from);
            QCOMPARE(change->second, to);
        }
    }

    void cardModelExposesTheChange()
    {
        CardModel card;
        QAbstractItemModelTester tester(&card, QAbstractItemModelTester::FailureReportingMode::QtTest);
        QVERIFY(card.load({{"cardId", "c1"}, {"turnId", "t1"}, {"expiresAt", 9e12},
                           {"items", QJsonArray{
                               QJsonObject{{"itemId", "b"}, {"tool", "settings.brightness"}, {"title", "Brightness"},
                                           {"detail", "40% → 70%"}, {"source", "system"}, {"risk", "confirm"}, {"secretFields", QJsonArray{}}},
                               QJsonObject{{"itemId", "p"}, {"tool", "pkg.install"}, {"title", "Install VLC"},
                                           {"detail", "1.0 → 1.1"}, {"source", "debian"}, {"risk", "confirm"}, {"secretFields", QJsonArray{}}}}}}));
        const QHash<int, QByteArray> roles = card.roleNames();
        const int fromRole = roles.key("changeFrom");
        const int toRole = roles.key("changeTo");
        QVERIFY(fromRole > 0 && toRole > 0);
        QCOMPARE(card.data(card.index(0), fromRole).toString(), u"40%"_s);
        QCOMPARE(card.data(card.index(0), toRole).toString(), u"70%"_s);
        QCOMPARE(card.data(card.index(1), fromRole).toString(), QString()); // only settings.*
    }

    void conversationToolLinesExposeTheChange()
    {
        Conversation c;
        c.applyEvent({{"type", "turn-start"}, {"turnId", "t1"}, {"text", "brighter"}});
        c.applyEvent({{"type", "tool"}, {"turnId", "t1"}, {"callId", "k1"}, {"name", "settings.brightness"},
                      {"status", "running"}, {"summary", "Setting brightness"}});
        const int row = c.rowCount() - 1;
        QCOMPARE(c.get(row).value(u"changeFrom"_s).toString(), QString());
        QSignalSpy changed(&c, &QAbstractItemModel::dataChanged);
        c.applyEvent({{"type", "tool"}, {"turnId", "t1"}, {"callId", "k1"}, {"name", "settings.brightness"},
                      {"status", "ok"}, {"summary", "40% → 70%"}});
        QCOMPARE(c.get(row).value(u"changeFrom"_s).toString(), u"40%"_s);
        QCOMPARE(c.get(row).value(u"changeTo"_s).toString(), u"70%"_s);
        const auto roles = changed.constLast().at(2).value<QList<int>>();
        QVERIFY(roles.contains(Conversation::ChangeFromRole));
    }
};

QTEST_GUILESS_MAIN(TestSettingChange)
#include "tst_settingchange.moc"
