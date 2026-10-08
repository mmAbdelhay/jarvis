import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    id: testCase
    name: "InstallingAndDone"
    when: windowShown
    visible: true
    width: 900
    height: 900

    Component { id: installingComponent; InstallingScreen {} }
    Component { id: doneComponent; DoneScreen {} }

    function installing() {
        const m = harness.fresh()
        tryCompare(m, "probed", true)
        m.next()
        m.next()
        m.account.fullName = "Mohamed Abdelhay"
        m.account.password = "abcdEF12"
        m.account.confirm = "abcdEF12"
        m.next()
        m.next()
        tryCompare(m, "step", 4)
        m.next()
        tryCompare(m, "step", 5)
        return m
    }

    function test_progressPerStepAndModelInParallel() {
        const m = installing()
        const s = createTemporaryObject(installingComponent, testCase, { installer: m, width: 780 })
        harness.progress("copy", 62, "Copying system files")
        harness.modelProgress(37, "1.9 of 5.2 GB")
        compare(findChild(s, "currentTitle").text, "Copy system files")
        compare(findChild(s, "currentPercent").text, "62% · Copying system files")
        compare(findChild(s, "currentMeter").fraction, 0.62)
        compare(findChild(s, "mark_partition").text, "✓")
        compare(findChild(s, "mark_copy").text, "…")
        compare(findChild(s, "mark_bootloader").text, "·")
        compare(findChild(s, "modelText").text, "Download Qwen3 8B · 1.9 of 5.2 GB")
        compare(findChild(s, "modelMeter").fraction, 0.37)
        verify(findChild(s, "whileYouWait").visible)
        verify(!findChild(s, "failure").visible)
    }

    function test_failureShowsTheStepAndMessage() {
        const m = installing()
        const s = createTemporaryObject(installingComponent, testCase, { installer: m, width: 780 })
        harness.progress("copy", 40, "")
        harness.finish(false, "copy", "unsquashfs: write error <b>x</b>")
        compare(findChild(s, "screenTitle").text, "Installation stopped")
        verify(findChild(s, "failure").visible)
        compare(findChild(s, "failTitle").text, "Installation stopped at: Copy system files")
        compare(findChild(s, "failMessage").text, "unsquashfs: write error <b>x</b>")
        compare(findChild(s, "failMessage").textFormat, Text.PlainText)

        compare(findChild(s, "mark_copy").text, "✕")
        compare(m.nextLabel, "Restart now")
    }

    function test_longFailureLogScrolls() {
        const m = installing()
        const s = createTemporaryObject(installingComponent, testCase, { installer: m, width: 780 })
        const log = []
        for (let i = 1; i <= 20; ++i)
            log.push("line " + i + " of the installer log")
        harness.finish(false, "copy", log.join("\n"))   // contracts §10: last 20 redacted log lines
        const box = findChild(s, "failLog")
        verify(box.height <= 240)
        verify(box.contentHeight > box.height)
    }

    function test_doneUsesTheDistroNameAndMentionsAPendingModel() {
        const m = installing()
        harness.modelProgress(60, "3.1 of 5.2 GB")
        harness.finish(true, "", "")
        compare(m.step, 6)
        const s = createTemporaryObject(doneComponent, testCase, { installer: m, width: 780 })
        compare(findChild(s, "doneTitle").text, "Rafiq is installed")
        verify(findChild(s, "modelLater").visible)
        verify(!findChild(s, "finishNote").visible)
    }

    function test_doneShowsTheBackendNote() {
        const m = installing()
        harness.modelProgress(100, "")
        harness.finish(true, "", "Secure Boot didn't accept the loader. Disable Secure Boot or enroll the key; see the log.")
        const s = createTemporaryObject(doneComponent, testCase, { installer: m, width: 780 })
        verify(!findChild(s, "modelLater").visible)
        verify(findChild(s, "finishNote").visible)
    }
}
