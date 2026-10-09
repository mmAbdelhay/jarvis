#include <QSignalSpy>
#include <QtTest>

#include "ShellFixture.h"
#include "models/PairingModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject pending(const QString& id = u"r1"_s, const QString& name = u"Pixel"_s)
{
    return {{"requestId", id}, {"deviceName", name}, {"address", "192.168.1.5"}, {"expiresAt", 1759900000000.0}};
}
}

class TestPairing : public QObject {
    Q_OBJECT
private slots:
    void hostileDeviceNameIsInert()
    {
        const QString hostile = u"Pixel‮evil​\nApprove me\tnow  "_s + QString(10'000, u'x');
        const QString clean = PairingModel::cleanName(hostile);
        QVERIFY(clean.size() <= 64);
        QVERIFY(clean.startsWith(u"Pixelevil Approve me now x"_s));
        for (const QChar c : clean) {
            QVERIFY(c.category() != QChar::Other_Control);
            QVERIFY(c.category() != QChar::Other_Format);
        }
        QVERIFY(clean.endsWith(u"…"_s));
        QCOMPARE(PairingModel::cleanName(u"‮​  "_s), u"Unnamed device"_s);
    }

    void badRequestIdShowsNoCard()
    {
        PairingModel model;
        for (const QString& id : {QString(), QString(500, u'9'), u"a<b>"_s, u"a\nb"_s}) {
            QVERIFY(!model.load(pending(id)));
            QVERIFY(!model.active());
        }
        QVERIFY(model.load(pending(u"4821abc"_s)));
        QVERIFY(model.active());
        QCOMPARE(model.address(), u"192.168.1.5"_s);
    }

    void answersOnce()
    {
        PairingModel model;
        QSignalSpy answered(&model, &PairingModel::answered);
        QVERIFY(model.load(pending()));
        model.approve();
        model.approve();
        model.deny();
        QCOMPARE(answered.size(), 1);
        QCOMPARE(answered[0][0].toString(), u"r1"_s);
        QVERIFY(answered[0][1].toBool());
        QVERIFY(!model.active());
    }

    void lockedCannotApprove()
    {
        PairingModel model;
        QSignalSpy answered(&model, &PairingModel::answered);
        QVERIFY(model.load(pending()));
        model.setLocked(true);
        model.approve();
        QCOMPARE(answered.size(), 0);
        QVERIFY(model.active());
        model.deny();
        QCOMPARE(answered.size(), 1);
        QVERIFY(!answered[0][1].toBool());
    }

    void expiryClosesWithoutAnswering()
    {
        PairingModel model;
        QSignalSpy answered(&model, &PairingModel::answered);
        QVERIFY(model.load(pending()));
        for (int i = 0; i < PairingModel::kSeconds; ++i)
            model.tick();
        QVERIFY(!model.active());
        QCOMPARE(answered.size(), 0); // jarvisd times it out as a refusal
    }

    void shellShowsAndAnswers()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.shell->showView(u"audit"_s);
        f.push(u"pairing:pending"_s, pending(u"r1"_s, u"Muhammad's Pixel"_s));
        QTRY_VERIFY(f.shell->pairing()->active());
        QCOMPARE(f.shell->view(), u"chat"_s);
        f.shell->pairing()->approve();
        QTRY_COMPARE(f.requests(u"pairing:answer"_s).size(), 1);
        const QJsonObject answer = f.requests(u"pairing:answer"_s)[0].value("a").toArray().at(0).toObject();
        QCOMPARE(answer.value("requestId").toString(), u"r1"_s);
        QVERIFY(answer.value("approve").toBool());
    }

    void lockedShellRefusesToApprove()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"sys:snapshot"_s, fixture::snapshot(true));
        f.push(u"pairing:pending"_s, pending());
        QTRY_VERIFY(f.shell->pairing()->active());
        QTRY_VERIFY(f.shell->pairing()->locked());
        f.shell->pairing()->approve();
        f.shell->answerPairing(u"r1"_s, true); // even called directly
        QTest::qWait(100);
        QVERIFY(f.requests(u"pairing:answer"_s).isEmpty());
        QCOMPARE(f.lastNotice(), u"The screen is locked. Unlock it to allow a new phone."_s);
    }

    void disconnectClosesTheCard()
    {
        ShellFixture f;
        QVERIFY(f.open());
        f.push(u"pairing:pending"_s, pending());
        QTRY_VERIFY(f.shell->pairing()->active());
        f.daemon.dropClients();
        QTRY_VERIFY(!f.shell->pairing()->active());
    }
};

QTEST_GUILESS_MAIN(TestPairing)
#include "tst_pairing.moc"
