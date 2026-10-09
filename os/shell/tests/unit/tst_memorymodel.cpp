#include <QAbstractItemModelTester>
#include <QJsonArray>
#include <QJsonObject>
#include <QSignalSpy>
#include <QtTest>

#include "models/MemoryModel.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject memory(const QString& id, const QString& kind, const QString& text)
{
    return {{"id", id}, {"kind", kind}, {"text", text}, {"createdAt", 1759900000000.0}};
}
} // namespace

class TestMemoryModel : public QObject {
    Q_OBJECT
private slots:
    void enablingMemoryRequestsTheExplicitChoice()
    {
        MemoryModel m;
        QSignalSpy enabled(&m, &MemoryModel::setEnabledRequested);
        m.setEnabled(true);
        m.setEnabled(false);
        QCOMPARE(enabled.size(), 2);
        QCOMPARE(enabled.at(0).first().toBool(), true);
        QCOMPARE(enabled.at(1).first().toBool(), false);
    }
    void keepsWellFormedItemsInOrder()
    {
        MemoryModel m;
        QAbstractItemModelTester tester(&m);
        QSignalSpy lists(&m, &MemoryModel::listRequested);
        m.refresh();
        QCOMPARE(lists.size(), 1);
        QCOMPARE(lists.first().first().toInt(), 500);
        QVERIFY(m.loading());
        m.applyItems(QJsonArray{memory(u"m2"_s, u"fact"_s, u"prefers Flatpak"_s),
                                memory(u"m1"_s, u"summary"_s, u"Installed GIMP."_s),
                                memory(QString(), u"fact"_s, u"no id"_s),
                                memory(u"m3"_s, u"secret"_s, u"bad kind"_s),
                                QJsonObject{{"id", "m4"}, {"kind", "fact"}, {"text", 5}, {"createdAt", 1.0}}});
        QVERIFY(m.known());
        QVERIFY(!m.loading());
        QCOMPARE(m.count(), 2);
        QCOMPARE(m.data(m.index(0), MemoryModel::IdRole).toString(), u"m2"_s);
        QCOMPARE(m.data(m.index(0), MemoryModel::KindLabelRole).toString(), u"Fact"_s);
        QCOMPARE(m.data(m.index(1), MemoryModel::KindLabelRole).toString(), u"Conversation summary"_s);
        QVERIFY(!m.data(m.index(1), MemoryModel::TimeTextRole).toString().isEmpty());
    }

    void forgettingOneEmitsItsIdAndDropsTheRowWhenDone()
    {
        MemoryModel m;
        QAbstractItemModelTester tester(&m);
        QSignalSpy deletes(&m, &MemoryModel::deleteRequested);
        m.applyItems(QJsonArray{memory(u"m1"_s, u"fact"_s, u"a"_s), memory(u"m2"_s, u"fact"_s, u"b"_s)});
        m.remove(1);
        QCOMPARE(deletes.first().first().toString(), u"m2"_s);
        QCOMPARE(m.count(), 2); // not gone until jarvisd says so
        m.applyDeleted(u"m2"_s);
        QCOMPARE(m.count(), 1);
        m.remove(7);
        QCOMPARE(deletes.size(), 1);
    }

    void forgettingEverything()
    {
        MemoryModel m;
        QSignalSpy clears(&m, &MemoryModel::clearRequested);
        m.clearAll(); // nothing to clear: nothing sent
        QCOMPARE(clears.size(), 0);
        m.applyItems(QJsonArray{memory(u"m1"_s, u"fact"_s, u"a"_s)});
        m.clearAll();
        QCOMPARE(clears.size(), 1);
        m.applyCleared();
        QCOMPARE(m.count(), 0);
    }

    void errorsAreKeptUntilTheNextList()
    {
        MemoryModel m;
        m.refresh();
        m.applyError(u"Memory is off: the keyring is locked."_s);
        QVERIFY(!m.loading());
        QCOMPARE(m.error(), u"Memory is off: the keyring is locked."_s);
        m.applyItems(QJsonArray{});
        QCOMPARE(m.error(), QString());
    }
};

QTEST_GUILESS_MAIN(TestMemoryModel)
#include "tst_memorymodel.moc"
