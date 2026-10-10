import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    id: testCase
    name: "ThemedCombo"
    when: windowShown
    visible: true
    width: 400
    height: 400

    Component { id: comboComponent; ThemedCombo { width: 300; model: ["qwen3:8b", "llama3.2:3b"] } }
    Component { id: emptyComponent; ThemedCombo { width: 300; model: []; enabled: count > 0; displayText: "Models load after the connection check" } }

    function lightness(c) { return (Math.max(c.r, c.g, c.b) + Math.min(c.r, c.g, c.b)) / 2 }

    function test_disabledStaysDark() {
        const box = createTemporaryObject(emptyComponent, testCase)
        waitForRendering(box)
        verify(!box.enabled)
        compare(box.background.color.toString(), Theme.fieldDisabled.toString())
        compare(box.contentItem.color.toString(), Theme.textDisabled.toString())
        verify(lightness(box.background.color) < 0.15)
        compare(box.opacity, 1)
    }

    function test_enabledUsesTheSurface() {
        const box = createTemporaryObject(comboComponent, testCase)
        compare(box.background.color.toString(), Theme.surface.toString())
        compare(box.contentItem.color.toString(), Theme.text.toString())
        compare(box.contentItem.text, "qwen3:8b")
    }

    function test_popupIsDarkAndPicks() {
        const box = createTemporaryObject(comboComponent, testCase)
        mouseClick(box)
        tryVerify(() => box.popup.opened)
        compare(box.popup.background.color.toString(), Theme.surfaceRaised.toString())
        keyClick(Qt.Key_Down)
        keyClick(Qt.Key_Return)
        compare(box.currentIndex, 1)
    }

    function test_tokens() {
        compare(Theme.fieldDisabled.toString(), Theme.surfaceDeep.toString())
        compare(Theme.textDisabled.toString(), Theme.mutedSoft.toString())
    }
}
