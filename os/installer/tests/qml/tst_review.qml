import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    id: testCase
    name: "ReviewScreen"
    when: windowShown
    visible: true
    width: 900
    height: 900

    Component { id: screenComponent; ReviewScreen {} }

    function toReview(summary) {
        const m = harness.fresh()
        tryCompare(m, "probed", true)
        if (summary)
            harness.setSummary(summary)
        m.next()
        m.next()
        m.account.fullName = "Mohamed Abdelhay"
        m.account.password = "abcdEF12"
        m.account.confirm = "abcdEF12"
        m.next()
        m.next()
        tryCompare(m, "step", 4)
        const s = createTemporaryObject(screenComponent, testCase, { installer: m, width: 780 })
        waitForRendering(s)
        return { m: m, s: s }
    }

    function test_summaryIsShownVerbatim() {
        const c = toReview()
        compare(findChild(c.s, "screenTitle").text, "Ready to install")
        compare(findChild(c.s, "summaryLine_0").text, "Language: English · English (US) keyboard · Africa/Cairo")
        compare(findChild(c.s, "summaryLine_1").text, "Shrink Windows from 510 GB to 362 GB, create 148 GB encrypted Rafiq")
        compare(findChild(c.s, "summaryLine_3").text, "Brain: Qwen3 8B on this computer (5.2 GB download)")
        compare(findChild(c.s, "warning_0").text, "Windows and its files are kept. Back up anything important first.")
        verify(findChild(c.s, "diskAfter").visible)
        verify(harness.calls().indexOf("Execute") < 0)
    }

    function test_markupInTheSummaryStaysText() {
        const c = toReview(["<b>Erase</b> <a href='x'>disk</a>"])
        const line = findChild(c.s, "summaryLine_0")
        compare(line.textFormat, Text.PlainText)
        compare(line.text, "<b>Erase</b> <a href='x'>disk</a>")
    }

    function test_noticeSaysWhenChangesStart() {
        const c = toReview()
        verify(findChild(c.s, "installNotice").visible)
        compare(findChild(c.s, "noticeText").text, "Changes to the disk start when you press Install.")
    }
}
