import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Avatar, name and password field with the greeter's look (M2 Login design),
// shared with jarvis-lock. The typed secret leaves only through submitted()
// and the field is cleared in the same step.
ColumnLayout {
    id: root
    property string initial: ""
    property string displayName: ""
    property string prompt: "Password"
    property bool busy: false
    property string errorText: ""
    property string infoText: ""
    property string submitLabel: "Unlock"
    signal submitted(string secret)

    function focusField() { passwordField.forceActiveFocus(Qt.OtherFocusReason) }
    function clear() { passwordField.clear() }
    function submit() {
        const secret = passwordField.text
        passwordField.clear()
        if (secret.length > 0 && !root.busy)
            root.submitted(secret)
    }

    width: 360
    spacing: 16
    Accessible.role: Accessible.Form
    Accessible.name: root.submitLabel

    Rectangle {
        objectName: "avatar"
        Layout.alignment: Qt.AlignHCenter
        implicitWidth: 88
        implicitHeight: 88
        radius: 44
        color: Theme.accentTintBorder
        Text {
            objectName: "avatarInitial"
            anchors.centerIn: parent
            text: root.initial
            textFormat: Text.PlainText
            color: Theme.accentTintText
            font.pixelSize: 36
            font.weight: Font.Medium
        }
    }
    Text {
        objectName: "name"
        Layout.alignment: Qt.AlignHCenter
        Layout.maximumWidth: 360
        text: root.displayName
        textFormat: Text.PlainText
        color: Theme.text
        font.pixelSize: Math.round(20 * Theme.textScale)
        font.weight: Font.DemiBold
        elide: Text.ElideRight
    }
    RowLayout {
        Layout.fillWidth: true
        spacing: 8
        TextField {
            id: passwordField
            objectName: "passwordField"
            Layout.fillWidth: true
            implicitHeight: 48
            leftPadding: 16
            enabled: !root.busy
            placeholderText: root.prompt
            placeholderTextColor: Theme.mutedSoft
            echoMode: TextInput.Password
            passwordCharacter: "•"
            inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase | Qt.ImhHiddenText
            color: Theme.text
            font.pixelSize: Theme.fontSize
            Accessible.name: root.prompt
            background: Rectangle {
                radius: 12
                color: Theme.surface
                border.color: Theme.borderStrong
                Rectangle {
                    anchors.fill: parent
                    anchors.margins: -4
                    radius: 16
                    color: "transparent"
                    border.width: 2
                    border.color: Theme.accent
                    visible: passwordField.activeFocus
                }
            }
            onAccepted: root.submit()
        }
        AbstractButton {
            id: submitButton
            objectName: "submitButton"
            implicitWidth: 48
            implicitHeight: 48
            enabled: !root.busy
            Accessible.name: root.submitLabel
            Accessible.role: Accessible.Button
            onClicked: root.submit()
            contentItem: Item {
                Icon { anchors.centerIn: parent; path: Icons.arrowRight; color: Theme.accentInk; strokeWidth: 2; size: 20 }
            }
            background: Rectangle { radius: 12; color: Theme.accent; opacity: submitButton.enabled ? 1 : 0.5 }
        }
    }
    Text {
        objectName: "errorText"
        Layout.fillWidth: true
        visible: text.length > 0
        text: root.errorText
        textFormat: Text.PlainText
        color: Theme.warn
        font.pixelSize: Theme.fontSmall
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.Wrap
    }
    Text {
        objectName: "infoText"
        Layout.fillWidth: true
        visible: text.length > 0
        text: root.infoText
        textFormat: Text.PlainText
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.Wrap
    }
}
