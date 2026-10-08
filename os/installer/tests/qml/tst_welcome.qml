import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Installer

TestCase {
    id: testCase
    name: "WelcomeScreen"
    when: windowShown
    visible: true
    width: 900
    height: 700

    Component { id: screenComponent; WelcomeScreen {} }

    function make(options) {
        const m = harness.fresh(options || {})
        const s = createTemporaryObject(screenComponent, testCase, { installer: m, width: 780 })
        return { m: m, s: s }
    }

    function test_timezoneDetectionRequiresExplicitClick() {
        const c = make()
        tryCompare(c.m, "probed", true)
        let requested = ""
        c.s.timezoneLookup = function(url, done) {
            requested = url
            done("<Response><TimeZone>Europe/Paris</TimeZone></Response>")
        }
        compare(requested, "")
        verify(findChild(c.s, "timezonePrivacy").text.indexOf("geoip.ubuntu.com") >= 0)
        mouseClick(findChild(c.s, "detectTimezone"))
        compare(requested, "https://geoip.ubuntu.com/lookup")
        compare(c.m.locale.timezone, "Europe/Paris")
        compare(harness.calls().length, 1)
    }

    function test_detectedValuesAreShown() {
        const c = make()
        tryCompare(c.m, "probed", true)
        compare(findChild(c.s, "screenTitle").text, "Welcome")
        compare(findChild(c.s, "language").combo.displayText, "English")
        compare(findChild(c.s, "keyboard").combo.displayText, "English (US)")
        compare(findChild(c.s, "timezone").combo.displayText, "Africa/Cairo")
        verify(findChild(c.s, "voiceHint") === null) // M3
    }

    function test_languageDrivesKeyboard() {
        const c = make()
        tryCompare(c.m, "probed", true)
        const language = findChild(c.s, "language").combo
        language.forceActiveFocus()
        keyClick(Qt.Key_Down)                         // English → العربية
        compare(c.m.locale.language, "ar_EG.UTF-8")
        compare(c.m.locale.keyboard, "ara")
        compare(findChild(c.s, "keyboard").combo.displayText, "Arabic")
    }

    function test_noUefiExplainsAndBlocks() {
        const c = make({ uefi: false })
        tryCompare(c.m, "probed", true)
        const notice = findChild(c.s, "uefiNotice")
        verify(notice.visible)
        verify(findChild(c.s, "uefiText").text.indexOf("Rafiq needs UEFI") >= 0)
        verify(!c.m.canContinue)
    }

    function test_probeFailureCanBeRetried() {
        const c = make({ failProbe: true })
        tryCompare(c.m, "canRetryProbe", true)
        verify(findChild(c.s, "probeError").visible)
        mouseClick(findChild(c.s, "retryProbe"))
        tryCompare(c.m, "probed", true)
        verify(!findChild(c.s, "probeError").visible)
    }
}
