import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// The prompt box: Enter sends, the Send button turns into Stop while a turn runs.
ColumnLayout {
    id: root
    property bool busy: false
    property bool undoAvailable: false
    signal undoRequested()
    property VoiceModel voice: null
    signal micRequested()
    signal submit(string text)
    signal stopRequested()

    function focusInput() { input.forceActiveFocus(Qt.OtherFocusReason) }
    function send() {
        const text = input.text.trim()
        if (text.length === 0 || root.busy)
            return
        root.submit(text)
        input.clear()
    }

    spacing: 8

    Loader {
        objectName: "voiceIndicator"
        Layout.fillWidth: true
        active: root.voice !== null
        visible: active && root.voice.state !== "idle"
        sourceComponent: VoiceIndicator { voice: root.voice }
    }

    Rectangle {
        Layout.fillWidth: true
        implicitHeight: 60
        radius: 16
        color: Theme.surface
        border.color: input.activeFocus ? Theme.accentTintBorder : Theme.borderStrong

        RowLayout {
            anchors.fill: parent
            anchors.leftMargin: 18
            anchors.rightMargin: 8
            spacing: 10

            TextField {
                id: input
                objectName: "promptField"
                Layout.fillWidth: true
                placeholderText: "Ask Jarvis to do anything on this computer…"
                placeholderTextColor: Theme.mutedSoft
                color: Theme.text
                maximumLength: 8000
                background: null
                Accessible.name: "Message Jarvis"
                onAccepted: root.send()
            }
            IconButton {
                objectName: "micButton"
                visible: root.voice !== null && root.voice.available
                implicitWidth: 44
                implicitHeight: 44
                text: root.voice && root.voice.recording ? "Send voice message" : "Talk to Jarvis (Super+Space)"
                iconPath: Icons.mic
                fill: root.voice && root.voice.recording ? Theme.accent : Theme.surfaceRaised
                ink: root.voice && root.voice.recording ? Theme.accentInk : Theme.textSoft
                onClicked: root.micRequested()
            }
            IconButton {
                objectName: "undoButton"
                visible: root.undoAvailable && !root.busy
                implicitWidth: 44
                implicitHeight: 44
                text: "Undo the last change"
                iconPath: Icons.undo
                fill: Theme.surfaceRaised
                ink: Theme.textSoft
                onClicked: root.undoRequested()
            }
            IconButton {
                objectName: "sendButton"
                visible: !root.busy
                implicitWidth: 44
                implicitHeight: 44
                text: "Send"
                iconPath: Icons.send
                fill: Theme.accent
                ink: Theme.accentInk
                onClicked: root.send()
            }
            IconButton {
                objectName: "stopButton"
                visible: root.busy
                implicitWidth: 44
                implicitHeight: 44
                text: "Stop Jarvis"
                iconPath: Icons.stop
                fill: Theme.surfaceRaised
                ink: Theme.warn
                onClicked: root.stopRequested()
            }
        }
    }
    Text {
        objectName: "voiceHint"
        Layout.fillWidth: true
        visible: root.voice !== null && root.voice.hint.length > 0
        text: root.voice ? root.voice.hint : ""
        textFormat: Text.PlainText
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.Wrap
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }
    Text {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        text: "Super focuses chat · Super+Space talks · Esc stops Jarvis · Ctrl+Alt+T opens a terminal"
        color: Theme.mutedSoft
        font.pixelSize: Theme.fontTiny
    }
}
