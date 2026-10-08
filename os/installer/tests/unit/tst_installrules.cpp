#include <QJsonArray>
#include <QtTest>

#include "Fixtures.h"
#include "InstallRules.h"

using namespace Qt::StringLiterals;
using namespace jarvis::installer;

class TestInstallRules : public QObject {
    Q_OBJECT
private slots:
    void sizes()
    {
        QCOMPARE(formatSize(512110190592), u"512 GB"_s);
        QCOMPARE(formatSize(5200000000), u"5.2 GB"_s);
        QCOMPARE(formatSize(1500000000000), u"1.5 TB"_s);
        QCOMPARE(formatSize(734003200), u"734 MB"_s);
        QCOMPARE(formatSize(-5), u"0 MB"_s);
    }

    void usernames_data()
    {
        QTest::addColumn<QString>("fullName");
        QTest::addColumn<QString>("username");
        QTest::newRow("first word") << u"Mohamed Abdelhay"_s << u"mohamed"_s;
        QTest::newRow("accents") << u"José Núñez"_s << u"jose"_s;
        QTest::newRow("hyphen") << u"  Anne-Marie  Smith"_s << u"anne-marie"_s;
        QTest::newRow("arabic gives nothing") << u"محمد"_s << QString();
        QTest::newRow("leading digits dropped") << u"3D Bob"_s << u"d"_s;
        QTest::newRow("long is cut") << u"Abcdefghijklmnopqrstuvwxyzabcdefghij"_s << u"abcdefghijklmnopqrstuvwxyzabcdef"_s;
        QTest::newRow("empty") << QString() << QString();
    }
    void usernames()
    {
        QFETCH(QString, fullName);
        QFETCH(QString, username);
        QCOMPARE(deriveUsername(fullName), username);
    }

    void usernameRules()
    {
        QCOMPARE(usernameProblem(u"mohamed"_s), QString());
        QCOMPARE(usernameProblem(u"m_a-2"_s), QString());
        QCOMPARE(usernameProblem(QString()), u"Choose a username."_s);
        QVERIFY(usernameProblem(u"Mohamed"_s).startsWith(u"Use lowercase"_s));
        QVERIFY(usernameProblem(u"2pac"_s).startsWith(u"Use lowercase"_s));
        QVERIFY(usernameProblem(u"a b"_s).startsWith(u"Use lowercase"_s));
        QVERIFY(usernameProblem(QString(33, u'a')).startsWith(u"Use lowercase"_s));
        QCOMPARE(usernameProblem(u"root"_s), u"That name is used by the system. Pick another."_s);
        QCOMPARE(usernameProblem(u"ollama"_s), u"That name is used by the system. Pick another."_s);
    }

    void hostnames()
    {
        QCOMPARE(deriveHostname(u"mohamed"_s), u"mohamed-computer"_s);
        QCOMPARE(deriveHostname(QString()), QString());
        QCOMPARE(hostnameProblem(u"mohamed-computer"_s), QString());
        QCOMPARE(hostnameProblem(QString()), u"Choose a computer name."_s);
        QVERIFY(!hostnameProblem(u"-x"_s).isEmpty());
        QVERIFY(!hostnameProblem(u"x-"_s).isEmpty());
        QVERIFY(!hostnameProblem(u"My PC"_s).isEmpty());
        QVERIFY(!hostnameProblem(QString(64, u'a')).isEmpty());
    }

    void passwords()
    {
        QCOMPARE(passwordStrength(QString()), Strength::Empty);
        QCOMPARE(passwordStrength(u"abc123"_s), Strength::Weak);
        QCOMPARE(passwordStrength(u"abcdefgh"_s), Strength::Fair);
        QCOMPARE(passwordStrength(u"abcdEF12"_s), Strength::Strong);
        QCOMPARE(passwordStrength(u"correct horse"_s), Strength::Strong);
        QCOMPARE(passwordStatus(QString(), QString()), QString());
        QCOMPARE(passwordStatus(u"abc"_s, QString()), u"Too short: use at least 8 characters"_s);
        QCOMPARE(passwordStatus(u"abcdEF12"_s, u"abcdEF12"_s), u"Strong password · passwords match"_s);
        QCOMPARE(passwordStatus(u"abcdefgh"_s, u"abcdefgX"_s), u"Fair password · passwords don't match"_s);
        QVERIFY(passwordAcceptable(u"abcdefgh"_s, u"abcdefgh"_s));
        QVERIFY(!passwordAcceptable(u"abcdefgh"_s, u"abcdefg"_s));
        QVERIFY(!passwordAcceptable(u"abc"_s, u"abc"_s));
    }

    void windowsPartitionUsesBackendSelection()
    {
        const QJsonObject disk = loadFixture(u"probe-windows.json"_s).value("disks").toArray().at(0).toObject();
        const auto windows = windowsPartition(disk);
        QVERIFY(windows.has_value());
        QCOMPARE(windows->path, u"/dev/nvme0n1p2"_s);
        QCOMPARE(windows->minSizeBytes, qint64(215000000000));
        // Backend bounds are authoritative.
        QCOMPARE(alongsideMaxBytes(*windows), qint64(295000000000));
        QCOMPARE(alongsideRefusalKey(*windows), QString());
        const QJsonObject usb = loadFixture(u"probe-windows.json"_s).value("disks").toArray().at(1).toObject();
        QVERIFY(!windowsPartition(usb).has_value());
    }

    void refusalKeysForWindows()
    {
        WindowsPartition w{u"/dev/x"_s, 510000000000, 210000000000, 215000000000, false, false, false};
        w.maxAlongsideBytes = 295000000000;
        w.dirty = true;
        QCOMPARE(alongsideRefusalKey(w), u"ntfs-dirty"_s);
        w.hibernated = true;
        QCOMPARE(alongsideRefusalKey(w), u"ntfs-hibernated"_s);
        w.bitlocker = true;
        QCOMPARE(alongsideRefusalKey(w), u"ntfs-bitlocker"_s); // BitLocker wins: hibernate advice would not help
        WindowsPartition full{u"/dev/y"_s, 100000000000, 95000000000, 95000000000, false, false, false};
        full.maxAlongsideBytes = 0;
        QCOMPARE(alongsideMaxBytes(full), qint64(0));
        QCOMPARE(alongsideRefusalKey(full), u"alongside-too-small"_s);
        WindowsPartition roomy{u"/dev/z"_s, 510000000000, 210000000000, 215000000000, false, false, false};
        roomy.maxAlongsideBytes = 295000000000;
        QCOMPARE(alongsideRefusalKey(roomy, 300000000000), u"alongside-too-small"_s); // ProbeResult.minRootBytes wins
    }

    void modelsThatFitAreRankedBestFirst()
    {
        const QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        const QJsonArray fit = modelsThatFit(probe, 148000000000);
        QCOMPARE(fit.size(), 2); // 14B needs 32 GB RAM, gpt-oss needs a 16 GB GPU
        QCOMPARE(fit.at(0).toObject().value("id").toString(), u"qwen3-8b"_s);
        QCOMPARE(fit.at(1).toObject().value("id").toString(), u"qwen3-4b"_s);
        // 20 GiB stays free for the system beside the model
        QCOMPARE(modelsThatFit(probe, 2600000000 + kSystemReserveBytes).size(), 1);
        QCOMPARE(modelsThatFit(probe, 2600000000 + kSystemReserveBytes - 1).size(), 0);
    }

    void backupModelIsNeverOffered()
    {
        // Contracts §6.12: UIs hide role == "backup", even if a backend passes it
        // through. Otherwise a low-RAM target where only the 1.7B backup fits
        // would get it as its recommended (index 0) brain.
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        QJsonArray catalog = probe.value("catalog").toArray();
        catalog.prepend(QJsonObject{{"id", u"qwen3-1.7b"_s},       {"ollamaTag", u"qwen3:1.7b"_s},
                                    {"displayName", u"Qwen3 1.7B"_s}, {"sizeBytes", qint64(1359293444)},
                                    {"minRamGB", 4},                 {"tier", u"small"_s},
                                    {"toolCalling", u"verified"_s},  {"role", u"backup"_s},
                                    {"fits", true}});
        QJsonObject main = catalog.at(1).toObject();
        main.insert("role", u"main"_s);
        catalog[1] = main;
        probe.insert("catalog", catalog);
        const QJsonArray fit = modelsThatFit(probe, 148000000000);
        QCOMPARE(fit.size(), 2);
        for (const QJsonValue& m : fit)
            QVERIFY(m.toObject().value("role").toString() != u"backup"_s);
        QCOMPARE(modelsThatFit(probe, 1359293444 + kSystemReserveBytes).size(), 0); // only the backup would fit
    }

    void backendDecisionsAreAuthoritative()
    {
        QJsonObject probe = loadFixture(u"probe-windows.json"_s);
        QJsonObject disk = probe.value("disks").toArray().at(0).toObject();
        disk.insert("windowsPartition", u"/dev/nvme0n1p3"_s);
        QCOMPARE(windowsPartition(disk)->path, u"/dev/nvme0n1p3"_s);
        disk.insert("windowsPartition", QJsonValue::Null);
        QVERIFY(!windowsPartition(disk));
        disk.remove("windowsPartition");
        QVERIFY(!windowsPartition(disk));
        disk.insert("windowsPartition", u"/dev/missing"_s);
        QVERIFY(!windowsPartition(disk));
        disk.insert("windowsPartition", u"/dev/nvme0n1p2"_s);
        disk.insert("alongsideBounds", QJsonObject{{"minBytes", kMinSystemBytes}, {"maxBytes", qint64(295123456789)}});
        QCOMPARE(alongsideMaxBytes(*windowsPartition(disk)), qint64(295123456789));
        disk.insert("alongsideBounds", QJsonValue::Null);
        QCOMPARE(alongsideMaxBytes(*windowsPartition(disk)), qint64(0));
        QVERIFY(refusalKeys().contains(u"alongside-no-windows"_s));
        QCOMPARE(splitRefusal(u"alongside-no-windows: No Windows."_s).first, u"alongside-no-windows"_s);
        QVERIFY(!refusalText(u"alongside-no-windows"_s, {}, u"Rafiq"_s).isEmpty());
        QJsonArray catalog = probe.value("catalog").toArray();
        QJsonObject model = catalog.at(0).toObject();
        model.insert("minRamGB", 10000);
        model.insert("minVramGB", 10000);
        catalog[0] = model;
        model = catalog.at(1).toObject();
        model.insert("fits", false);
        catalog[1] = model;
        model = catalog.at(2).toObject();
        model.remove("fits");
        catalog[2] = model;
        probe.insert("catalog", catalog);
        QCOMPARE(modelsThatFit(probe, 148000000000).size(), 1);
        QCOMPARE(modelsThatFit(probe, 148000000000).at(0).toObject().value("id").toString(), u"qwen3-4b"_s);
    }

    void refusals()
    {
        QCOMPARE(refusalKeys().size(), 11);
        QVERIFY(refusalText(u"live-medium"_s, {}, u"Rafiq"_s).contains(u"USB stick"_s));
        QCOMPARE(splitRefusal(u"live-medium: That is the boot stick."_s).first, u"live-medium"_s);
        QCOMPARE(splitRefusal(u"ntfs-dirty: Volume is dirty"_s), (std::pair{u"ntfs-dirty"_s, u"Volume is dirty"_s}));
        QCOMPARE(splitRefusal(u"weird: thing"_s), (std::pair{QString(), u"weird: thing"_s}));
        QCOMPARE(splitRefusal(u"  no prefix "_s), (std::pair{QString(), u"no prefix"_s}));
        QVERIFY(refusalText(u"ntfs-hibernated"_s, {}, u"Rafiq"_s).contains(u"hold Shift + Shut down"_s));
        QVERIFY(refusalText(u"ntfs-dirty"_s, {}, u"Rafiq"_s).contains(u"hold Shift + Shut down"_s));
        QVERIFY(refusalText(u"ntfs-bitlocker"_s, {}, u"Rafiq"_s).contains(u"BitLocker"_s));
        QVERIFY(refusalText(u"no-uefi"_s, {}, u"Rafiq"_s).contains(u"Rafiq needs UEFI"_s));
        QVERIFY(refusalText(u"model-does-not-fit"_s, {}, u"Nova"_s).contains(u"space for Nova"_s));
        QCOMPARE(refusalText(QString(), u"Backend words."_s, u"Rafiq"_s), u"Backend words."_s);
        QCOMPARE(refusalText(QString(), QString(), u"Rafiq"_s), u"The installer can't go ahead with these choices."_s);
    }
};

QTEST_GUILESS_MAIN(TestInstallRules)
#include "tst_installrules.moc"
