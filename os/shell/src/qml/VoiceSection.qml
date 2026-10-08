import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Settings -> Voice (Rafiq M3 design 3.2): push-to-talk only, no wake word.
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property VoiceModel voice
    spacing: 14

    Text {
        objectName: "voiceStatus"
        Layout.fillWidth: true
        text: root.voice.available
              ? qsTr("Speech recognition: %1 · Voice: %2").arg(root.voice.sttName || qsTr("ready")).arg(root.voice.ttsName || qsTr("ready"))
              : qsTr("Voice isn't installed on this computer.")
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.text
    }
    CheckRow {
        objectName: "speakReplies"
        Layout.fillWidth: true
        text: qsTr("Speak Jarvis's replies aloud")
        enabled: root.voice.available
        checked: root.voice.speakReplies
        onToggled: root.voice.speakReplies = checked
    }
    Text {
        Layout.fillWidth: true
        text: qsTr("Push-to-talk only: press Super+Space or the mic button, speak, then press again to send. There is no wake word, so the microphone is on only when you turn it on.")
        wrapMode: Text.Wrap
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }
    Text {
        Layout.fillWidth: true
        text: qsTr("While a card is on screen you can answer it by voice: say “yes” or “no” (نعم / لا). Cards that need a password or a typed secret can't be answered by voice, and nothing can be approved while the screen is locked.")
        wrapMode: Text.Wrap
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }
}
