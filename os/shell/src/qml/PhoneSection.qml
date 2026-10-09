import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Settings → Phone (Rafiq M3 contracts §5.9): the Jarvis phone bridge on this
// computer — on/off, owner password, a pairing window and paired phones.
// Phone names are untrusted, so they render as plain text.
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property PhoneModel phone

    spacing: 14

    Text {
        Layout.fillWidth: true
        text: qsTr("Let the Jarvis app on your phone reach this computer over your local network. Phones can ask and approve everyday changes; they can never approve anything that needs your password.")
        wrapMode: Text.Wrap
        color: Theme.muted
    }
    CheckRow {
        objectName: "phoneEnabled"
        Layout.fillWidth: true
        text: qsTr("Allow my phone to connect")
        enabled: root.phone.known
        checked: root.phone.enabled
        onToggled: root.phone.setEnabled(checked)
    }
    Text {
        objectName: "phoneAddress"
        Layout.fillWidth: true
        visible: root.phone.enabled && root.phone.address !== ""
        text: qsTr("Listening on %1 · fingerprint %2").arg(root.phone.address).arg(root.phone.fingerprint)
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.textSoft
        font.pixelSize: Theme.fontSmall
    }
    Text {
        objectName: "phoneProblem"
        Layout.fillWidth: true
        visible: root.phone.problem !== ""
        text: root.phone.problem
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.warn
    }
    Text {
        objectName: "phoneError"
        Layout.fillWidth: true
        visible: root.phone.error !== ""
        text: root.phone.error
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.warn
    }
    Text {
        objectName: "phoneNote"
        Layout.fillWidth: true
        visible: root.phone.note !== ""
        text: root.phone.note
        textFormat: Text.PlainText
        color: Theme.muted
    }

    // Pairing: jarvisd returns the jarvis:// URI the phone app opens.
    RowLayout {
        Layout.fillWidth: true
        visible: root.phone.enabled
        spacing: 12
        ActionButton {
            objectName: "phonePair"
            visible: root.phone.pairingUri === ""
            text: qsTr("Pair a phone")
            onClicked: root.phone.openPairing()
        }
        TextEdit {
            objectName: "phonePairingUri"
            Layout.fillWidth: true
            visible: root.phone.pairingUri !== ""
            text: root.phone.pairingUri
            textFormat: TextEdit.PlainText
            readOnly: true
            selectByMouse: true
            wrapMode: TextEdit.WrapAnywhere
            color: Theme.text
        }
        ActionButton {
            objectName: "phonePairCancel"
            visible: root.phone.pairingUri !== ""
            text: qsTr("Stop pairing")
            onClicked: root.phone.cancelPairing()
        }
    }

    Repeater {
        model: root.phone.devices
        delegate: Rectangle {
            id: deviceRow
            required property var modelData
            objectName: "phoneDevice_" + modelData.id
            visible: root.phone.enabled
            Layout.fillWidth: true
            implicitHeight: deviceLayout.implicitHeight + 24
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: Theme.border

            RowLayout {
                id: deviceLayout
                anchors.fill: parent
                anchors.margins: 12
                spacing: 12
                Text {
                    objectName: "phoneDeviceName_" + deviceRow.modelData.id
                    Layout.fillWidth: true
                    text: deviceRow.modelData.name
                    textFormat: Text.PlainText
                    elide: Text.ElideRight
                    color: Theme.text
                }
                Text {
                    text: deviceRow.modelData.connected ? qsTr("Connected") : qsTr("Not connected")
                    color: Theme.mutedSoft
                    font.pixelSize: Theme.fontSmall
                }
                ActionButton {
                    objectName: "phoneRevoke_" + deviceRow.modelData.id
                    text: qsTr("Remove")
                    Accessible.name: qsTr("Remove %1").arg(deviceRow.modelData.name)
                    onClicked: root.phone.revoke(deviceRow.modelData.id)
                }
            }
        }
    }

    // Owner password: what the phone asks for before it can approve anything.
    Text {
        Layout.fillWidth: true
        Layout.topMargin: 8
        text: root.phone.hasOwnerPassword ? qsTr("Change the owner password") : qsTr("Set an owner password")
        color: Theme.text
        font.weight: Font.DemiBold
    }
    SecretField {
        id: currentPassword
        objectName: "phoneCurrentPassword"
        Layout.fillWidth: true
        visible: root.phone.hasOwnerPassword
        label: qsTr("Current owner password")
    }
    SecretField {
        id: newPassword
        objectName: "phoneNewPassword"
        Layout.fillWidth: true
        label: qsTr("New owner password")
    }
    ActionButton {
        objectName: "phoneSavePassword"
        variant: "primary"
        text: qsTr("Save password")
        enabled: newPassword.field.text !== ""
        onClicked: {
            root.phone.setOwnerPassword(currentPassword.field.text, newPassword.field.text)
            currentPassword.field.text = ""
            newPassword.field.text = ""
        }
    }
}
