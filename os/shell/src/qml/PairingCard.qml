import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// A phone asking to connect (design §3.3: the pairing dialog is now a shell
// card). Don't allow takes focus; Allow is impossible while locked. The
// device name and address come from the phone: plain text only.
Rectangle {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property PairingModel pairing
    objectName: "pairingCard"

    visible: pairing.active
    implicitHeight: column.implicitHeight + 32
    radius: Theme.radiusCard
    color: Theme.approvalCard
    border.color: Theme.approval
    Accessible.role: Accessible.Grouping
    Accessible.name: qsTr("A phone wants to connect to Jarvis")
    onVisibleChanged: if (visible) denyButton.forceActiveFocus(Qt.OtherFocusReason)
    Component.onCompleted: if (visible) denyButton.forceActiveFocus(Qt.OtherFocusReason)

    ColumnLayout {
        id: column
        anchors.fill: parent
        anchors.margins: 16
        spacing: 10

        RowLayout {
            spacing: 10
            Icon { path: Icons.phone; color: Theme.approval; strokeWidth: 2; size: 20 }
            Text {
                Layout.fillWidth: true
                text: qsTr("A phone wants to connect to Jarvis")
                color: Theme.text
                font.weight: Font.DemiBold
            }
        }
        Text {
            objectName: "pairingDevice"
            Layout.fillWidth: true
            text: qsTr("Device: %1").arg(root.pairing.deviceName)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: Theme.textSoft
        }
        Text {
            objectName: "pairingAddress"
            Layout.fillWidth: true
            visible: root.pairing.address !== ""
            text: qsTr("Address: %1").arg(root.pairing.address)
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: Theme.approvalMuted
            font.family: Theme.mono
        }
        Text {
            objectName: "pairingHint"
            Layout.fillWidth: true
            text: root.pairing.locked
                  ? qsTr("The screen is locked. Unlock it to allow this phone.")
                  : qsTr("Allow it only if you started pairing on this computer just now. It will be able to chat with Jarvis and answer cards that don't need a password. (%1 s)").arg(root.pairing.secondsLeft)
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: Theme.approvalMuted
            font.pixelSize: Theme.fontSmall
        }
        RowLayout {
            Layout.fillWidth: true
            Item { Layout.fillWidth: true }
            ActionButton {
                id: denyButton
                objectName: "pairingDeny"
                variant: "quiet"
                text: qsTr("Don't allow")
                onClicked: root.pairing.deny()
            }
            ActionButton {
                objectName: "pairingApprove"
                variant: "approve"
                text: qsTr("Allow")
                enabled: !root.pairing.locked
                onClicked: root.pairing.approve()
            }
        }
    }
}
