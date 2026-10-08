#include <QtTest>

#include "Language.h"
#include "ShellFixture.h"
#include "models/AuditModel.h"
#include "models/CardModel.h"
#include "models/SystemModel.h"
#include "models/PhoneModel.h"
#include "models/voice/Recorder.h"

using namespace Qt::StringLiterals;

namespace {
QJsonArray items(int n)
{
    QJsonArray out;
    for (int i = 0; i < n; ++i)
        out.append(fixture::item(u"i%1"_s.arg(i)));
    return out;
}
} // namespace

class TestShellTranslations : public QObject {
    Q_OBJECT
    jarvis::ui::LanguageManager* m_language = nullptr;

private slots:
    void initTestCase()
    {
        qputenv("JARVIS_I18N_DIR", JARVIS_TEST_I18N_DIR);
        m_language = new jarvis::ui::LanguageManager({u"jarvis-ui"_s, u"jarvis-shell"_s}, this);
        QVERIFY(m_language->setLanguage(u"ar"_s));
    }
    void cleanupTestCase() { m_language->setLanguage(u"en"_s); }

    void cardHeadlineUsesArabicPlurals()
    {
        CardModel two, three, eleven, hundred;
        QVERIFY(two.load(fixture::card(u"c2"_s, items(2))));
        QCOMPARE(two.headline(), u"يريد جارفيس تنفيذ إجراءين"_s);
        QVERIFY(three.load(fixture::card(u"c3"_s, items(3))));
        QCOMPARE(three.headline(), u"يريد جارفيس تنفيذ 3 إجراءات"_s);
        QVERIFY(eleven.load(fixture::card(u"c11"_s, items(11))));
        QCOMPARE(eleven.headline(), u"يريد جارفيس تنفيذ 11 إجراءً"_s);
        QCOMPARE(eleven.approveLabel(), u"الموافقة على الكل (11)"_s);
        QVERIFY(hundred.load(fixture::card(u"c100"_s, items(100))));
        QCOMPARE(hundred.headline(), u"يريد جارفيس تنفيذ 100 إجراء"_s);
    }

    void noticesAreArabic()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.pushCard(fixture::card(u"c1"_s, {fixture::item(u"a"_s)}));
        QTRY_VERIFY(f.shell->chatCard()->active());
        f.shell->decide(f.shell->chatCard(), false);
        f.push(u"agent:events"_s, QJsonObject{{"type", "card-closed"}, {"cardId", "c1"}, {"decision", "denied"}});
        QTRY_COMPARE(f.lastNotice(), u"تم الرفض. لم يتغيّر شيء."_s);
    }

    void systemTextIsArabic()
    {
        SystemModel system;
        QJsonObject snap = fixture::snapshot(false);
        snap.insert("network", QJsonObject{{"connectivity", "full"}, {"wifiSsid", "Home"}});
        system.applySnapshot(snap);
        QCOMPARE(system.networkDetail(), u"واي فاي Home · متصل"_s);
    }

    void phoneMessagesAreArabic()
    {
        PhoneModel phone;
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", true}});
        QCOMPARE(phone.note(), u"تم حفظ كلمة مرور المالك."_s);
        QVERIFY(phone.error().isEmpty());
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", false}, {"code", "current-wrong"}});
        QCOMPARE(phone.error(), u"كلمة مرور المالك الحالية غير صحيحة."_s);
        QVERIFY(phone.note().isEmpty());
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", false}, {"code", "current-required"}});
        QCOMPARE(phone.error(), u"أدخل كلمة مرور المالك الحالية أولًا."_s);
        phone.applyOwnerPasswordResult(QJsonObject{{"ok", false}});
        QCOMPARE(phone.error(), u"تعذّر حفظ كلمة مرور المالك."_s);
        phone.applyError({});
        QCOMPARE(phone.error(), u"حدث خطأ ما. حاول مجددًا."_s);
        phone.applyError(u"Server detail"_s);
        QCOMPARE(phone.error(), u"Server detail"_s);
    }

    void recorderErrorsAreArabic()
    {
        jarvis::voice::ProcessRecorder recorder(QStringList{}, 4096);
        QVERIFY(!recorder.start());
        QCOMPARE(recorder.error(), u"لا يوجد مسجّل صوت مثبّت (pacat أو pw-record)."_s);
    }

    void updateCountsUseArabicPlurals()
    {
        SystemModel system;
        system.applyUpdateCounts(2, 2);
        QCOMPARE(system.updatesText(), u"تحديثان · تحديثان أمنيان"_s);
        system.applyUpdateCounts(11, 3);
        QCOMPARE(system.updatesText(), u"11 تحديثًا · 3 تحديثات أمنية"_s);
    }

    void auditTimesUseArabicMonthsAndLatinDigits()
    {
        const QDateTime now(QDate(2026, 10, 9), QTime(12, 0));
        const QDateTime then(QDate(2026, 10, 7), QTime(9, 5));
        QCOMPARE(AuditModel::formatTime(then.toMSecsSinceEpoch(), now), u"7 أكتوبر 09:05"_s);
    }
};

QTEST_MAIN(TestShellTranslations)
#include "tst_shelltranslations.moc"
