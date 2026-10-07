import QtQuick
import QtTest
import Jarvis.UI

TestCase {
    id: testCase
    name: "Controls"
    when: windowShown
    visible: true
    width: 400
    height: 300

    Component { id: buttonComponent; ActionButton { text: "Deny" } }
    Component { id: iconButtonComponent; IconButton { text: "Chat"; iconPath: Icons.chat } }
    Component { id: tileComponent; ChoiceTile { title: "Cloud"; detail: "Strongest models." } }
    Component { id: fieldComponent; LabeledField { label: "API key"; secret: true } }
    Component { id: spyComponent; SignalSpy {} }

    function test_designTokens() {
        compare(Theme.bg.toString(), "#0d1014")
        compare(Theme.surfaceDeep.toString(), "#0b0e12")
        compare(Theme.surface.toString(), "#151a20")
        compare(Theme.surfaceRaised.toString(), "#1c222a")
        compare(Theme.border.toString(), "#222932")
        compare(Theme.borderStrong.toString(), "#2a323c")
        compare(Theme.text.toString(), "#e7eaee")
        compare(Theme.textSoft.toString(), "#c9cfd6")
        compare(Theme.muted.toString(), "#9aa4b1")
        compare(Theme.mutedSoft.toString(), "#8a94a1")
        compare(Theme.accent.toString(), "#4fd8c4")
        compare(Theme.approval.toString(), "#f2b33d")
        compare(Theme.approvalCard.toString(), "#1a1710")
        compare(Theme.approvalBorder.toString(), "#3a3220")
        compare(Theme.warn.toString(), "#fb923c")
        compare(Theme.sans, "IBM Plex Sans")
        compare(Theme.mono, "IBM Plex Mono")
        compare(Theme.fontSize, 15)
        compare(Theme.controlHeight, 44)
    }

    function test_actionButtonClicks() {
        const button = createTemporaryObject(buttonComponent, testCase)
        const spy = createTemporaryObject(spyComponent, testCase, { target: button, signalName: "clicked" })
        mouseClick(button)
        compare(spy.count, 1)
        compare(button.implicitHeight, Theme.controlHeight)
        compare(button.variant, "ghost")
    }

    function test_iconButtonIsAccessible() {
        const button = createTemporaryObject(iconButtonComponent, testCase)
        compare(button.Accessible.name, "Chat")
        compare(button.implicitWidth, 48)
    }

    function test_choiceTileIsARadio() {
        const tile = createTemporaryObject(tileComponent, testCase, { width: 300 })
        compare(tile.Accessible.role, Accessible.RadioButton)
        verify(!tile.Accessible.checked)
        tile.selected = true
        verify(tile.Accessible.checked)
    }

    function test_labeledFieldMasksSecrets() {
        const field = createTemporaryObject(fieldComponent, testCase, { width: 300 })
        compare(field.input.echoMode, TextInput.Password)
        compare(field.input.Accessible.name, "API key")
    }
}
