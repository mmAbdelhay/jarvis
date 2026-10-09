import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    name: "Rtl"
    when: windowShown
    visible: true
    width: 420
    height: 360

    function cleanup() { testLanguage.setLanguage("en") }

    Component {
        id: page
        Item {
            width: 400
            height: 340
            LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
            LayoutMirroring.childrenInherit: true
            property alias check: check
            property alias meter: meter
            property alias arrow: arrow
            property alias panel: panel
            property alias change: change
            CheckRow { id: check; width: 300; text: "x" }
            Meter { id: meter; y: 40; width: 200; fraction: 0.25 }
            Icon { id: arrow; y: 60; path: Icons.arrowRight; mirrorInRtl: true }
            ChangeValue { id: change; y: 90; from: "40%"; to: "70%" }
            PasswordPanel { id: panel; y: 120 }
        }
    }

    function test_englishIsLeftToRight() {
        const item = createTemporaryObject(page, this)
        verify(item.check.indicator.x < item.check.width / 2)
        compare(item.meter.children[0].x, 0)
        compare(item.arrow.transform[0].xScale, 1)
        compare(item.panel.prompt, "Password")
        compare(item.panel.submitLabel, "Unlock")
        compare(item.change.Accessible.name, "From 40% to 70%")
        compare(Theme.sans, "IBM Plex Sans")
    }

    function test_arabicMirrorsAndTranslates() {
        verify(testLanguage.setLanguage("ar"))
        const item = createTemporaryObject(page, this)
        verify(item.check.indicator.x > item.check.width / 2)
        compare(item.meter.children[0].x, 150)
        compare(item.arrow.transform[0].xScale, -1)
        compare(item.panel.prompt, "كلمة المرور")
        compare(item.panel.submitLabel, "فتح القفل")
        compare(item.change.Accessible.name, "من 40% إلى 70%")
        compare(Theme.sans, "IBM Plex Sans Arabic")
    }

    function test_liveObjectsFollowASwitch() {
        const item = createTemporaryObject(page, this)
        compare(item.panel.prompt, "Password")
        verify(testLanguage.setLanguage("ar"))
        tryCompare(item.panel, "prompt", "كلمة المرور")
        tryVerify(() => item.check.indicator.x > item.check.width / 2)
        verify(testLanguage.setLanguage("en"))
        tryCompare(item.panel, "prompt", "Password")
        tryVerify(() => item.check.indicator.x < item.check.width / 2)
    }
}
