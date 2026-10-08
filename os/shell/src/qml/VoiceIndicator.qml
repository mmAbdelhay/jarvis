import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// The voice pill above the prompt box: the open mic (with its level), the
// wait for the transcript, or Jarvis speaking.
Rectangle {
    id: root
    required property VoiceModel voice
    implicitHeight: 40
    radius: 20
    color: Theme.accentTint
    border.color: Theme.accentTintBorder
    Accessible.role: Accessible.StaticText
    Accessible.name: stateText.text

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 14
        anchors.rightMargin: 14
        spacing: 10
        Icon { path: root.voice.state === "speaking" ? Icons.speaker : Icons.mic; color: Theme.accent; size: 18 }
        Rectangle {
            objectName: "voiceLevel"
            visible: root.voice.recording
            implicitWidth: 6 + Math.round(60 * root.voice.level)
            implicitHeight: 6
            radius: 3
            color: Theme.accent
        }
        Text {
            id: stateText
            objectName: "voiceState"
            Layout.fillWidth: true
            text: root.voice.statusText
            textFormat: Text.PlainText
            color: Theme.accentTintText
            font.pixelSize: Theme.fontSmall
            elide: Text.ElideRight
        }
    }
}
