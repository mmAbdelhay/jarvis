import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Settings -> Voice (Rafiq M3 design 3.2): push-to-talk only, no wake word.
ColumnLayout {
    id: root
    required property VoiceModel voice
    spacing: 14

    Text {
        objectName: "voiceStatus"
        Layout.fillWidth: true
        text: root.voice.available
              ? "Speech recognition: " + (root.voice.sttName || "ready") + " · Voice: " + (root.voice.ttsName || "ready")
              : "Voice isn't installed on this computer."
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.text
    }
    CheckRow {
        objectName: "speakReplies"
        Layout.fillWidth: true
        text: "Speak Jarvis's replies aloud"
        enabled: root.voice.available
        checked: root.voice.speakReplies
        onToggled: root.voice.speakReplies = checked
    }
    Text {
        Layout.fillWidth: true
        text: "Push-to-talk only: press Super+Space or the mic button, speak, then press again to send. There is no wake word, so the microphone is on only when you turn it on."
        wrapMode: Text.Wrap
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }
    Text {
        Layout.fillWidth: true
        text: "While a card is on screen you can answer it by voice: say “yes” or “no” (نعم / لا). Cards that need a password or a typed secret can't be answered by voice, and nothing can be approved while the screen is locked."
        wrapMode: Text.Wrap
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }
}
