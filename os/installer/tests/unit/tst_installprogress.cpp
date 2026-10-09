#include <QJsonArray>
#include <QtTest>

#include "Fixtures.h"
#include "InstallProgress.h"

using namespace Qt::StringLiterals;

namespace {
QString stateOf(const InstallProgress& p, const QString& stepId)
{
    for (const QVariant& row : p.rows())
        if (row.toMap().value(u"stepId"_s) == stepId)
            return row.toMap().value(u"state"_s).toString();
    return u"missing"_s;
}
} // namespace

class TestInstallProgress : public QObject {
    Q_OBJECT
private slots:
    void modelStepIsShownApart()
    {
        InstallProgress p;
        p.setPlanSteps(loadFixture(u"plan-alongside.json"_s).value("steps").toArray());
        QCOMPARE(p.rows().size(), 6);
        QCOMPARE(stateOf(p, u"model"_s), u"missing"_s);
        QVERIFY(p.modelVisible());
        QCOMPARE(p.modelTitle(), u"Download Qwen3 8B"_s);
        QCOMPARE(stateOf(p, u"partition"_s), u"pending"_s);
    }

    void progressMarksEarlierStepsDone()
    {
        InstallProgress p;
        p.setPlanSteps(loadFixture(u"plan-alongside.json"_s).value("steps").toArray());
        p.applyProgress(u"copy"_s, 62, u"Copying system files"_s);
        QCOMPARE(stateOf(p, u"partition"_s), u"done"_s);
        QCOMPARE(stateOf(p, u"format"_s), u"done"_s);
        QCOMPARE(stateOf(p, u"copy"_s), u"running"_s);
        QCOMPARE(stateOf(p, u"bootloader"_s), u"pending"_s);
        QCOMPARE(p.currentTitle(), u"Copy system files"_s);
        QCOMPARE(p.currentPercent(), 62);
        QCOMPARE(p.currentDetail(), u"Copying system files"_s);
        p.applyProgress(u"copy"_s, 140, {});
        QCOMPARE(p.currentPercent(), 100);
        QCOMPARE(stateOf(p, u"copy"_s), u"done"_s);
        p.applyProgress(u"nonsense"_s, 10, {});
        QCOMPARE(p.currentTitle(), u"Copy system files"_s);
        p.applyProgress(u"model"_s, 20, u"1 of 5.2 GB"_s);        // tolerated on Progress too
        QCOMPARE(p.modelPercent(), 20);
    }

    void modelProgressIsClamped()
    {
        InstallProgress p;
        p.setPlanSteps(loadFixture(u"plan-alongside.json"_s).value("steps").toArray());
        p.applyModelProgress(-3, u"waiting"_s);
        QCOMPARE(p.modelPercent(), 0);
        p.applyModelProgress(37, u"1.9 of 5.2 GB"_s);
        QCOMPARE(p.modelPercent(), 37);
        QCOMPARE(p.modelDetail(), u"1.9 of 5.2 GB"_s);
    }

    void finishOkAndFailure()
    {
        InstallProgress ok;
        ok.setPlanSteps(loadFixture(u"plan-alongside.json"_s).value("steps").toArray());
        ok.finish(true, {}, u"Secure Boot refused our loader. See the note."_s);
        QVERIFY(ok.done());
        QCOMPARE(stateOf(ok, u"bootloader"_s), u"done"_s);
        QCOMPARE(ok.finishNote(), u"Secure Boot refused our loader. See the note."_s);

        InstallProgress bad;
        bad.setPlanSteps(loadFixture(u"plan-alongside.json"_s).value("steps").toArray());
        bad.applyProgress(u"copy"_s, 40, {});
        bad.finish(false, u"copy"_s, u"unsquashfs: write error"_s);
        QVERIFY(bad.failed());
        QCOMPARE(stateOf(bad, u"copy"_s), u"failed"_s);
        QCOMPARE(bad.failTitle(), u"Installation stopped at: Copy system files"_s);
        QCOMPARE(bad.failMessage(), u"unsquashfs: write error"_s);
        bad.applyProgress(u"bootloader"_s, 50, {});          // nothing moves after the end
        QCOMPARE(stateOf(bad, u"bootloader"_s), u"pending"_s);
    }
};

QTEST_GUILESS_MAIN(TestInstallProgress)
#include "tst_installprogress.moc"
