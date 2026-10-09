#include <QJsonArray>
#include <QtTest>
#include <functional>

#include "DiskChoice.h"
#include "Fixtures.h"

using namespace Qt::StringLiterals;

namespace {
QJsonObject probeWith(const std::function<void(QJsonObject& ntfs)>& edit)
{
    QJsonObject probe = loadFixture(u"probe-windows.json"_s);
    QJsonArray disks = probe.value("disks").toArray();
    QJsonObject disk = disks.at(0).toObject();
    QJsonArray parts = disk.value("partitions").toArray();
    QJsonObject windows = parts.at(1).toObject();
    QJsonObject ntfs = windows.value("ntfs").toObject();
    edit(ntfs);
    windows.insert("ntfs", ntfs);
    parts.replace(1, windows);
    disk.insert("partitions", parts);
    disks.replace(0, disk);
    probe.insert("disks", disks);
    return probe;
}
QVariantMap option(const DiskChoice& d, const QString& id)
{
    for (const QVariant& o : d.options())
        if (o.toMap().value(u"id"_s) == id)
            return o.toMap();
    return {};
}
} // namespace

class TestDiskChoice : public QObject {
    Q_OBJECT
private slots:
    void windowsLaptopDefaultsToAlongside()
    {
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(loadFixture(u"probe-windows.json"_s));
        QCOMPARE(d.diskPath(), u"/dev/nvme0n1"_s);
        QCOMPARE(d.disks().size(), 1);                       // liveDevice /dev/sda is hidden entirely
        d.setDiskPath(u"/dev/sda"_s);
        QCOMPARE(d.diskPath(), u"/dev/nvme0n1"_s);
        QCOMPARE(d.description(), u"Samsung 980 NVMe · 512 GB · contains Windows on /dev/nvme0n1p2 (210 GB used)"_s);
        QCOMPARE(d.mode(), u"alongside"_s);
        QVERIFY(d.encrypt());
        QCOMPARE(qint64(d.alongsideBytes()), qint64(147000000000)); // half of the shrinkable 295 GB, whole GB
        QCOMPARE(qint64(d.alongsideMinBytes()), qint64(34000000000)); // 30 GiB + 1 GiB /boot, rounded up
        QCOMPARE(qint64(d.alongsideMaxBytes()), qint64(295000000000));
        QCOMPARE(d.alongsideText(), u"Give Rafiq 147 GB. Windows keeps 363 GB."_s);
        QCOMPARE(option(d, u"alongside"_s).value(u"detail"_s).toString(),
                 u"Give Rafiq 147 GB. Choose which system to start each time you boot."_s);
        QCOMPARE(option(d, u"erase"_s).value(u"detail"_s).toString(), u"Deletes Windows and every file on this disk."_s);
        QVERIFY(d.valid());
        QCOMPARE(d.targetBytes(), qint64(147000000000));
        QCOMPARE(d.toJson(), (QJsonObject{{"path", "/dev/nvme0n1"}, {"mode", "alongside"}, {"alongsideSizeBytes", 147000000000.0}}));
        QVERIFY(d.barVisible());
        QCOMPARE(d.ourLabel(), u"Rafiq"_s);
    }

    // M4 contracts §6.8: the Arabic installer names the distro in Arabic.
    void distroNameFollowsTheLanguage()
    {
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(loadFixture(u"probe-windows.json"_s));
        QSignalSpy changed(&d, &DiskChoice::changed);
        d.setDistroName(u"\u0631\u0641\u064a\u0642"_s);
        QCOMPARE(changed.count(), 1);
        QCOMPARE(d.ourLabel(), u"\u0631\u0641\u064a\u0642"_s);
        QVERIFY(d.alongsideText().contains(u"\u0631\u0641\u064a\u0642"_s));
        d.setDistroName(u"\u0631\u0641\u064a\u0642"_s);
        QCOMPARE(changed.count(), 1); // unchanged: no signal
    }

    void sliderSnapsAndClamps()
    {
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(loadFixture(u"probe-windows.json"_s));
        d.setAlongsideBytes(200400000000.0);
        QCOMPARE(qint64(d.alongsideBytes()), qint64(200000000000));
        d.setAlongsideBytes(1e15);
        QCOMPARE(qint64(d.alongsideBytes()), qint64(295000000000));
        d.setAlongsideBytes(1.0);
        QCOMPARE(qint64(d.alongsideBytes()), qint64(34000000000)); // encrypted: 30 GiB + 1 GiB /boot
    }

    void hibernatedWindowsDisablesAlongsideWithTheReason()
    {
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(probeWith([](QJsonObject& ntfs) { ntfs.insert("hibernated", true); }));
        const QVariantMap alongside = option(d, u"alongside"_s);
        QVERIFY(!alongside.value(u"enabled"_s).toBool());
        QVERIFY(alongside.value(u"reason"_s).toString().contains(u"hold Shift + Shut down"_s));
        QCOMPARE(d.mode(), QString());                         // never default to erasing Windows
        QVERIFY(!d.valid());
        QVERIFY(d.blockText().startsWith(u"Choose how to install Rafiq"_s));
        d.setMode(u"alongside"_s);
        QCOMPARE(d.mode(), QString());
        d.setMode(u"erase"_s);
        QCOMPARE(d.mode(), u"erase"_s);
        QVERIFY(d.valid());
        QCOMPARE(d.targetBytes(), qint64(512110190592));
        QCOMPARE(d.otherFraction(), 0.0);
    }

    void bitlockerReason()
    {
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(probeWith([](QJsonObject& ntfs) { ntfs.insert("bitlocker", true); }));
        QVERIFY(option(d, u"alongside"_s).value(u"reason"_s).toString().contains(u"BitLocker"_s));
    }

    void smallDiskCannotBeErased()
    {
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        probe.insert("liveDevice", QJsonValue::Null);          // booted some other way: the stick is a target
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(probe);
        QCOMPARE(d.disks().size(), 2);
        QCOMPARE(d.disks().at(1).toMap().value(u"text"_s).toString(), u"SanDisk Ultra · 32 GB · removable"_s);
        d.setDiskPath(u"/dev/sda"_s);                          // 32.0 GB < minRootBytes 30 GiB
        QCOMPARE(d.mode(), QString());
        QVERIFY(option(d, u"alongside"_s).isEmpty());
        QVERIFY(!option(d, u"erase"_s).value(u"enabled"_s).toBool());
        QVERIFY(option(d, u"erase"_s).value(u"reason"_s).toString().startsWith(u"This disk is too small for Rafiq"_s));
        QCOMPARE(d.blockText(), u"Choose where to install Rafiq."_s);
        d.setMode(u"erase"_s);
        QCOMPARE(d.mode(), QString());
        d.setDiskPath(u"/dev/does-not-exist"_s);
        QCOMPARE(d.diskPath(), u"/dev/sda"_s);
    }

    void minRootComesFromTheProbe()
    {
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        probe.insert("minRootBytes", 600000000000.0);
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(probe);
        QVERIFY(!option(d, u"erase"_s).value(u"enabled"_s).toBool());     // 512 GB < 600 GB
        QVERIFY(!option(d, u"alongside"_s).value(u"enabled"_s).toBool());
        QCOMPARE(d.mode(), QString());
    }

    void diskWithoutWindowsDefaultsToErase()
    {
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        QJsonArray disks = probe.value("disks").toArray();
        QJsonObject disk = disks.at(0).toObject();
        QJsonArray parts = disk.value("partitions").toArray();
        disk.insert("partitions", QJsonArray{parts.at(0)}); // only the ESP is left
        disks.replace(0, disk);
        probe.insert("disks", disks);
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(probe);
        QCOMPARE(d.mode(), u"erase"_s);
        QVERIFY(option(d, u"alongside"_s).isEmpty());
        QCOMPARE(option(d, u"erase"_s).value(u"detail"_s).toString(), u"Deletes every file on this disk."_s);
        QCOMPARE(d.description(), u"Samsung 980 NVMe · 512 GB"_s);
        QVERIFY(d.valid());
    }

    void manualNeedsRootAndEsp()
    {
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(loadFixture(u"probe-windows.json"_s));
        d.setMode(u"manual"_s);
        QCOMPARE(d.manualRows().size(), 3);
        QVERIFY(!d.valid());
        QCOMPARE(d.blockText(), u"Choose a partition for / (the system)."_s);
        d.setManualMount(u"/dev/nvme0n1p2"_s, u"/"_s);
        QCOMPARE(d.blockText(), u"Choose an EFI system partition for /boot/efi."_s);
        d.setManualMount(u"/dev/nvme0n1p1"_s, u"/boot/efi"_s);
        QVERIFY(!d.valid()); // fixture ESP is smaller than 300 MB
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        QJsonArray disks = probe.value("disks").toArray();
        QJsonObject disk = disks.at(0).toObject();
        QJsonArray parts = disk.value("partitions").toArray();
        QJsonObject esp = parts.at(0).toObject();
        esp.insert("sizeBytes", 300000000);
        parts.replace(0, esp); disk.insert("partitions", parts);
        disks.replace(0, disk); probe.insert("disks", disks);
        d.applyProbe(probe); d.setMode(u"manual"_s);
        d.setManualMount(u"/dev/nvme0n1p2"_s, u"/"_s);
        d.setManualMount(u"/dev/nvme0n1p1"_s, u"/boot/efi"_s);
        QCOMPARE(d.blockText(), jarvis::installer::refusalText(u"manual-missing-boot"_s, {}, u"Rafiq"_s)); // encrypted: a separate /boot
        d.setEncrypt(false);
        QVERIFY(d.valid());
        d.setManualFormat(u"/dev/nvme0n1p2"_s, false);
        QVERIFY(d.manualRows().at(1).toMap().value(u"format"_s).toBool());
        d.setManualMount(u"/dev/nvme0n1p3"_s, u"swap"_s);
        QVERIFY(d.valid()); // a swap partition is fine without encryption
        d.setEncrypt(true);
        QVERIFY(!d.valid());
        d.setEncrypt(false);
        d.setManualMount(u"/dev/nvme0n1p3"_s, QString());
        d.setManualMount(u"/dev/nvme0n1p3"_s, u"/"_s);           // "/" moves, it is not duplicated
        const QVariantList rows = d.manualRows();
        QCOMPARE(rows.at(1).toMap().value(u"mount"_s).toString(), QString());
        QCOMPARE(rows.at(2).toMap().value(u"mount"_s).toString(), u"/"_s);
        QVERIFY(rows.at(2).toMap().value(u"format"_s).toBool());
        d.setManualFormat(u"/dev/nvme0n1p1"_s, false);
        d.setManualMount(u"/dev/nvme0n1p2"_s, u"/home"_s);       // not offered in M2
        QCOMPARE(d.toJson(), (QJsonObject{{"path", "/dev/nvme0n1"}, {"mode", "manual"},
                                         {"manual", QJsonArray{QJsonObject{{"partition", "/dev/nvme0n1p1"}, {"mount", "/boot/efi"}, {"format", false}},
                                                               QJsonObject{{"partition", "/dev/nvme0n1p3"}, {"mount", "/"}, {"format", true}}}}}));
        QCOMPARE(d.targetBytes(), qint64(734003200));
        QVERIFY(!d.barVisible());
    }

    // M2 contracts §12: encrypted manual installs need a separate,
    // formatted, unencrypted /boot of at least 500 MB; unencrypted ones none.
    void manualEncryptedNeedsBoot()
    {
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        QJsonArray disks = probe.value("disks").toArray();
        QJsonObject disk = disks.at(0).toObject();
        QJsonArray parts = disk.value("partitions").toArray();
        QJsonObject esp = parts.at(0).toObject();
        esp.insert("sizeBytes", 300000000);
        parts.replace(0, esp); disk.insert("partitions", parts);
        disks.replace(0, disk); probe.insert("disks", disks);
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(probe);
        d.setMode(u"manual"_s);
        QVERIFY(d.mountPoints().contains(u"/boot"_s));
        d.setManualMount(u"/dev/nvme0n1p2"_s, u"/"_s);
        d.setManualMount(u"/dev/nvme0n1p1"_s, u"/boot/efi"_s);
        QCOMPARE(d.blockText(), u"Encrypted installs need a separate, unencrypted partition for /boot (at least 500 MB). Choose one, or turn encryption off."_s);
        d.setManualMount(u"/dev/nvme0n1p3"_s, u"/boot"_s);
        QVERIFY2(d.valid(), qPrintable(d.blockText()));
        QVERIFY(d.manualRows().at(2).toMap().value(u"format"_s).toBool()); // /boot is always formatted
        d.setManualFormat(u"/dev/nvme0n1p3"_s, false);
        QVERIFY(d.manualRows().at(2).toMap().value(u"format"_s).toBool());
        QVERIFY(d.toJson().value("manual").toArray().contains(QJsonObject{{"partition", "/dev/nvme0n1p3"}, {"mount", "/boot"}, {"format", true}}));
        d.setEncrypt(false);
        QVERIFY(!d.valid()); // no separate /boot without encryption
        QVERIFY(d.blockText().contains(u"only used with encryption"_s));
        d.setEncrypt(true);
        QVERIFY(d.valid());
        // A /boot that is too small is refused.
        d.setManualMount(u"/dev/nvme0n1p3"_s, QString());
        d.setManualMount(u"/dev/nvme0n1p1"_s, u"/boot"_s);
        QVERIFY(!d.valid());
    }

    void encryptMovesTheAlongsideMinimum()
    {
        DiskChoice d(u"Rafiq"_s);
        d.applyProbe(loadFixture(u"probe-windows.json"_s));
        QCOMPARE(qint64(d.alongsideMinBytes()), qint64(34000000000));
        d.setEncrypt(false);
        QCOMPARE(qint64(d.alongsideMinBytes()), qint64(33000000000));
        d.setAlongsideBytes(33000000000.0);
        QCOMPARE(qint64(d.alongsideBytes()), qint64(33000000000));
        d.setEncrypt(true); // the size grows to the new minimum
        QCOMPARE(qint64(d.alongsideBytes()), qint64(34000000000));
    }

    void sliderUsesBackendBounds()
    {
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        QJsonArray disks = probe.value("disks").toArray();
        QJsonObject disk = disks.at(0).toObject();
        disk.insert("alongsideBounds", QJsonObject{{"minBytes", 80000000000.0}, {"maxBytes", 120000000000.0}});
        disks.replace(0, disk); probe.insert("disks", disks);
        DiskChoice d(u"Rafiq"_s); d.applyProbe(probe);
        QCOMPARE(d.alongsideMinBytes(), 82000000000.0); // + 1 GiB /boot (encrypted), whole GB
        QCOMPARE(d.alongsideMaxBytes(), 120000000000.0);
        QCOMPARE(d.alongsideBytes(), 120000000000.0);
        disk.insert("alongsideBounds", QJsonValue::Null);
        disks.replace(0, disk); probe.insert("disks", disks);
        d.applyProbe(probe);
        QVERIFY(!option(d, u"alongside"_s).value(u"enabled"_s).toBool());
        QCOMPARE(d.mode(), QString());
    }

    void encryptToggles()
    {
        DiskChoice d(u"Rafiq"_s);
        d.setEncrypt(false);
        QVERIFY(!d.encrypt());
    }
};

QTEST_GUILESS_MAIN(TestDiskChoice)
#include "tst_diskchoice.moc"
