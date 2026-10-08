import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// The login screen (design: Login.dc.html): clock, ring art, avatar, password
// field with focus, "Other user", model status line, keyboard indicator,
// large-text toggle and power menu. All outside text is plain text.
Rectangle {
    id: root
    required property LoginModel login
    required property ModelStatus modelStatus
    property string keyboardCode: "EN"
    property string keyboardName: "English (US)"

    color: Theme.surfaceDeep

    function focusField() { passwordField.forceActiveFocus(Qt.OtherFocusReason) }
    Component.onCompleted: focusField()
    Connections {
        target: root.login
        function onFailuresChanged() { passwordField.clear() } // H: cleared after a failed login
        function onStateChanged() {
            if (root.login.state === "prompt" || root.login.state === "idle") {
                passwordField.clear()
                Qt.callLater(root.focusField) // after `enabled` has been re-evaluated
            }
        }
    }

    Icon {
        x: (root.width - width) / 2
        y: 0
        path: Icons.rings
        color: Theme.ringFaint
        strokeWidth: 0.25
        size: Math.min(root.width, root.height)
    }

    ColumnLayout {
        anchors.top: parent.top
        anchors.topMargin: 96
        anchors.horizontalCenter: parent.horizontalCenter
        spacing: 4
        Text {
            id: clock
            objectName: "clock"
            Layout.alignment: Qt.AlignHCenter
            text: Qt.formatTime(new Date(), "HH:mm")
            color: Theme.text
            font.pixelSize: Math.round(96 * Theme.textScale)
            font.weight: Font.Light
            font.letterSpacing: -2
        }
        Text {
            id: dateText
            objectName: "date"
            Layout.alignment: Qt.AlignHCenter
            text: Qt.formatDate(new Date(), "dddd, d MMMM")
            color: Theme.muted
            font.pixelSize: Theme.fontSize
        }
        Timer {
            interval: 1000
            running: true
            repeat: true
            onTriggered: {
                clock.text = Qt.formatTime(new Date(), "HH:mm")
                dateText.text = Qt.formatDate(new Date(), "dddd, d MMMM")
            }
        }
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: 360
        spacing: 16
        Accessible.role: Accessible.Form
        Accessible.name: "Log in"

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
                text: root.login.initial
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
            text: root.login.displayName
            textFormat: Text.PlainText
            color: Theme.text
            font.pixelSize: Math.round(20 * Theme.textScale)
            font.weight: Font.DemiBold
            elide: Text.ElideRight
        }
        TextField {
            objectName: "usernameField"
            Layout.fillWidth: true
            visible: root.login.otherUser
            implicitHeight: 48
            leftPadding: 16
            placeholderText: "Username"
            placeholderTextColor: Theme.mutedSoft
            text: root.login.username
            color: Theme.text
            font.pixelSize: Theme.fontSize
            inputMethodHints: Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
            Accessible.name: "Username"
            background: Rectangle { radius: 12; color: Theme.surface; border.color: Theme.borderStrong }
            onTextEdited: root.login.username = text
            Keys.onReturnPressed: passwordField.forceActiveFocus()
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
                enabled: root.login.state === "idle" || root.login.state === "prompt"
                placeholderText: root.login.promptText
                placeholderTextColor: Theme.mutedSoft
                echoMode: root.login.promptSecret ? TextInput.Password : TextInput.Normal
                passwordCharacter: "•"
                inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase | Qt.ImhHiddenText
                color: Theme.text
                font.pixelSize: Theme.fontSize
                Accessible.name: root.login.promptText
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
                onAccepted: submitButton.clicked()
            }
            AbstractButton {
                id: submitButton
                objectName: "submitButton"
                implicitWidth: 48
                implicitHeight: 48
                enabled: passwordField.enabled
                Accessible.name: "Log in"
                Accessible.role: Accessible.Button
                onClicked: {
                    const secret = passwordField.text
                    passwordField.clear()
                    root.login.submit(secret)
                }
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
            text: root.login.errorText
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
            text: root.login.infoText
            textFormat: Text.PlainText
            color: Theme.muted
            font.pixelSize: Theme.fontSmall
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
        }
        AbstractButton {
            objectName: "otherUser"
            Layout.alignment: Qt.AlignHCenter
            visible: !root.login.otherUser || root.login.canSwitchUser
            text: root.login.otherUser ? "Back to " + root.login.displayNameOfDefault : "Other user"
            Accessible.name: text
            contentItem: Text { text: parent.text; textFormat: Text.PlainText; color: Theme.muted; font.pixelSize: 14 }
            background: null
            onClicked: root.login.otherUser ? root.login.useDefaultUser() : root.login.useOtherUser()
        }
    }

    RowLayout {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        anchors.margins: 40
        anchors.bottomMargin: 32
        spacing: 8

        RowLayout {
            spacing: 8
            visible: root.modelStatus.shown
            Rectangle {
                objectName: "statusDot"
                implicitWidth: 7
                implicitHeight: 7
                radius: 3.5
                color: root.modelStatus.ready ? Theme.accent : Theme.approval
            }
            Text {
                objectName: "statusText"
                text: root.modelStatus.text
                textFormat: Text.PlainText
                color: Theme.muted
                font.pixelSize: Theme.fontSmall
            }
        }
        Item { Layout.fillWidth: true }
        ActionButton {
            objectName: "keyboardButton"
            implicitHeight: 44
            leftPadding: 14
            rightPadding: 14
            font.pixelSize: Theme.fontSmall
            text: root.keyboardCode
            Accessible.name: "Keyboard layout: " + root.keyboardName
            focusPolicy: Qt.NoFocus // indicator only in M2
        }
        AbstractButton {
            id: largeText
            objectName: "largeText"
            implicitWidth: 44
            implicitHeight: 44
            checkable: true
            checked: Theme.textScale > 1
            Accessible.name: "Large text"
            onToggled: Theme.textScale = checked ? 1.25 : 1.0
            contentItem: Item { Icon { anchors.centerIn: parent; path: Icons.accessibility; color: Theme.textSoft; size: 18 } }
            background: Rectangle {
                radius: Theme.radiusControl
                color: largeText.checked ? Theme.accentTint : "transparent"
                border.color: largeText.checked ? Theme.accentTintBorder : Theme.borderStrong
            }
        }
        AbstractButton {
            id: powerButton
            objectName: "powerButton"
            implicitWidth: 44
            implicitHeight: 44
            enabled: root.login.powerAvailable
            Accessible.name: "Power"
            onClicked: powerMenu.open()
            contentItem: Item { Icon { anchors.centerIn: parent; path: Icons.power; color: Theme.textSoft; size: 18 } }
            background: Rectangle { radius: Theme.radiusControl; color: "transparent"; border.color: Theme.borderStrong }
            Menu {
                id: powerMenu
                objectName: "powerMenu"
                y: -implicitHeight - 8
                MenuItem { objectName: "shutDown"; text: "Shut down"; onTriggered: root.login.powerOff() }
                MenuItem { objectName: "restart"; text: "Restart"; onTriggered: root.login.reboot() }
            }
        }
    }
}
