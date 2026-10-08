import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    id: testCase
    name: "Additions"
    when: windowShown
    visible: true
    width: 500
    height: 400

    Component { id: cardComponent; Card { tone: "approval"; Text { objectName: "inside"; text: "hi" } } }
    Component { id: checkComponent; CheckRow { text: "Encrypt" } }
    Component { id: meterComponent; Meter { width: 200 } }
    Component { id: comboComponent; LabeledCombo { label: "Keyboard"; model: [{ value: "us", text: "English (US)" }, { value: "ara", text: "Arabic" }, { value: "fr", text: "French" }] } }
    Component { id: tileComponent; ChoiceTile { title: "This computer"; detail: "Private." } }
    Component { id: spyComponent; SignalSpy {} }

    function cleanup() { Theme.textScale = 1.0 }

    function test_newTokens() {
        compare(Theme.stepPending.toString(), "#3a434f")
        compare(Theme.otherOs.toString(), "#2a3a55")
        compare(Theme.otherOsText.toString(), "#d6e2f5")
        compare(Theme.ringFaint.toString(), "#141b22")
        compare(Theme.fontTitle, 32)
        for (const name of ["power", "accessibility", "arrowRight", "done", "download", "rings"])
            verify(Icons[name].length > 10, name)
    }

    function test_textScaleGrowsFonts() {
        Theme.textScale = 1.25
        compare(Theme.fontSize, 19)
        compare(Theme.fontSmall, 16)
        compare(Theme.fontTitle, 40)
    }

    function test_cardTones() {
        const card = createTemporaryObject(cardComponent, testCase)
        compare(card.color.toString(), Theme.approvalCard.toString())
        compare(card.border.color.toString(), Theme.approval.toString())
        verify(findChild(card, "inside") !== null)
        verify(card.implicitHeight > 2 * card.padding)
    }

    function test_checkRowToggles() {
        const check = createTemporaryObject(checkComponent, testCase, { width: 300 })
        verify(!check.checked)
        mouseClick(check)
        verify(check.checked)
        check.forceActiveFocus()
        keyClick(Qt.Key_Space)
        verify(!check.checked)
        compare(check.Accessible.name, "Encrypt")
    }

    function test_meterClamps() {
        const meter = createTemporaryObject(meterComponent, testCase, { fraction: 1.7 })
        compare(meter.children[0].width, 200)
        meter.fraction = -1
        compare(meter.children[0].width, 0)
        meter.fraction = 0.25
        compare(meter.children[0].width, 50)
    }

    function test_comboFollowsValueAndReportsPicks() {
        const combo = createTemporaryObject(comboComponent, testCase, { width: 300, value: "ara" })
        compare(combo.combo.currentIndex, 1)
        compare(combo.combo.displayText, "Arabic")
        const spy = createTemporaryObject(spyComponent, testCase, { target: combo, signalName: "picked" })
        combo.combo.forceActiveFocus()
        keyClick(Qt.Key_Down)
        compare(spy.count, 1)
        compare(spy.signalArguments[0][0], "fr")
        combo.value = "us"
        compare(combo.combo.currentIndex, 0)
    }

    function test_choiceTileBadgeAndDisabled() {
        const tile = createTemporaryObject(tileComponent, testCase, { width: 400 })
        compare(findChild(tile, "badge").visible, false)
        tile.badge = "Recommended"
        compare(findChild(tile, "badge").visible, true)
        compare(findChild(tile, "badgeText").text, "Recommended")
        tile.enabled = false
        compare(tile.opacity, 0.45)
    }
}
