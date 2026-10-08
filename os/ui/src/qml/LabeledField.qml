import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

// A labelled text input. `value` flows in from the model; edits flow out
// through edited(). `secret` masks it (API keys).
ColumnLayout {
    id: root
    property string label
    property string value
    property string placeholder
    property bool secret: false
    property bool mono: false
    readonly property alias input: field
    signal edited(string value)

    spacing: 6
    Text {
        text: root.label
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }
    TextField {
        id: field
        Layout.fillWidth: true
        implicitHeight: Theme.controlHeight
        leftPadding: 14
        rightPadding: 14
        text: root.value
        placeholderText: root.placeholder
        placeholderTextColor: Theme.mutedSoft
        echoMode: root.secret ? TextInput.Password : TextInput.Normal
        passwordCharacter: "•"
        inputMethodHints: root.secret ? (Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhHiddenText) : Qt.ImhUrlCharactersOnly
        color: Theme.text
        font.family: root.mono ? Theme.mono : Theme.sans
        font.pixelSize: root.mono ? 14 : Theme.fontSize
        Accessible.name: root.label
        background: Rectangle {
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: field.activeFocus ? Theme.accentTintBorder : Theme.borderStrong
        }
        onTextEdited: root.edited(text)
    }
}
