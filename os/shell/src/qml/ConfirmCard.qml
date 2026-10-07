import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// The batch confirm card (design: ConfirmBatch / Main). Deny takes keyboard
// focus whenever a new card appears; Approve runs only the ticked items; an
// expired card cannot be approved. In pick-one mode (several Wi-Fi networks)
// the ticks behave like radio buttons.
Rectangle {
    id: root
    required property CardModel card
    signal decided(bool approve)

    property string shownCardId: ""

    visible: card.active
    implicitWidth: 760
    implicitHeight: column.implicitHeight + 2
    radius: Theme.radiusCard
    color: Theme.approvalCard
    border.color: Theme.approval
    border.width: 1
    clip: true
    Accessible.role: Accessible.Grouping
    Accessible.name: "Approval needed"

    function focusDeny() {
        denyButton.forceActiveFocus(Qt.OtherFocusReason)
    }
    function noticeCard() {
        if (card.active && card.cardId !== shownCardId) {
            shownCardId = card.cardId
            focusDeny()
        } else if (!card.active) {
            shownCardId = ""
        }
    }
    Connections {
        target: root.card
        function onChanged() { root.noticeCard() }
    }
    Component.onCompleted: noticeCard()

    ColumnLayout {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: 1
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.leftMargin: 18
            Layout.rightMargin: 18
            Layout.topMargin: 14
            Layout.bottomMargin: 14
            spacing: 10
            Icon { path: Icons.shield; color: Theme.approval; strokeWidth: 2; size: 20 }
            Text {
                Layout.fillWidth: true
                text: root.card.headline
                textFormat: Text.PlainText
                color: Theme.text
                font.weight: Font.DemiBold
                elide: Text.ElideRight
            }
            Text {
                objectName: "countdown"
                text: root.card.countdownText
                color: Theme.approvalMuted
                font.family: Theme.mono
                font.pixelSize: Theme.fontSmall
            }
        }
        Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: Theme.approvalBorder }

        Repeater {
            model: root.card
            delegate: ColumnLayout {
                id: row
                required property int index
                required property string itemId
                required property string title
                required property string detail
                required property string sourceLabel
                required property bool ticked
                required property var secretFields

                Layout.fillWidth: true
                spacing: 0

                RowLayout {
                    Layout.fillWidth: true
                    Layout.leftMargin: 18
                    Layout.rightMargin: 18
                    Layout.topMargin: 14
                    Layout.bottomMargin: 14
                    spacing: 14

                    CheckBox {
                        id: tick
                        objectName: "tick_" + row.itemId
                        Layout.alignment: Qt.AlignTop
                        checked: row.ticked
                        padding: 0
                        Accessible.name: row.title
                        onToggled: {
                            root.card.setTicked(row.index, checked)
                            checked = Qt.binding(() => row.ticked)
                        }
                        indicator: Rectangle {
                            implicitWidth: 20
                            implicitHeight: 20
                            x: tick.leftPadding
                            y: (tick.height - height) / 2
                            radius: root.card.exclusive ? 10 : 4
                            color: tick.checked ? Theme.approval : "transparent"
                            border.color: Theme.approval
                            border.width: 1.5
                            Icon {
                                anchors.centerIn: parent
                                visible: tick.checked && !root.card.exclusive
                                path: Icons.check
                                color: Theme.approvalInk
                                strokeWidth: 3
                                size: 14
                            }
                            Rectangle {
                                anchors.centerIn: parent
                                visible: tick.checked && root.card.exclusive
                                width: 8
                                height: 8
                                radius: 4
                                color: Theme.approvalInk
                            }
                        }
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: 2
                        opacity: row.ticked ? 1 : 0.45
                        Text {
                            objectName: "title_" + row.itemId
                            Layout.fillWidth: true
                            text: row.title
                            textFormat: Text.PlainText
                            color: Theme.text
                            font.weight: Font.Medium
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "detail_" + row.itemId
                            Layout.fillWidth: true
                            visible: text.length > 0
                            text: row.detail
                            textFormat: Text.PlainText
                            color: Theme.approvalMuted
                            font.pixelSize: Theme.fontSmall
                            wrapMode: Text.Wrap
                        }
                    }

                    Rectangle {
                        Layout.alignment: Qt.AlignTop
                        opacity: row.ticked ? 1 : 0.45
                        implicitWidth: sourceText.implicitWidth + 16
                        implicitHeight: sourceText.implicitHeight + 4
                        radius: 6
                        color: "transparent"
                        border.color: Theme.approvalBorder
                        Text {
                            id: sourceText
                            objectName: "source_" + row.itemId
                            anchors.centerIn: parent
                            text: row.sourceLabel
                            textFormat: Text.PlainText
                            color: Theme.approvalMuted
                            font.pixelSize: Theme.fontTiny
                        }
                    }
                }

                Repeater {
                    model: row.ticked ? row.secretFields : []
                    delegate: SecretField {
                        required property var modelData
                        objectName: "secret_" + row.itemId + "_" + modelData.name
                        Layout.fillWidth: true
                        Layout.leftMargin: 52
                        Layout.rightMargin: 18
                        Layout.bottomMargin: 14
                        label: modelData.label
                        onEdited: (value) => root.card.setSecret(row.index, modelData.name, value)
                    }
                }

                Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: Theme.approvalDivider }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.leftMargin: 18
            Layout.rightMargin: 18
            Layout.topMargin: 14
            Layout.bottomMargin: 14
            spacing: 12
            Text {
                Layout.fillWidth: true
                text: root.card.exclusive ? "Pick one network." : "Untick anything you don't want. No answer in 5 minutes counts as Deny."
                color: Theme.approvalMuted
                font.pixelSize: Theme.fontSmall
                wrapMode: Text.Wrap
            }
            ActionButton {
                id: denyButton
                objectName: "denyButton"
                variant: "quiet"
                text: root.card.exclusive ? "Cancel" : "Deny"
                enabled: root.card.active
                onClicked: root.decided(false)
            }
            ActionButton {
                id: approveButton
                objectName: "approveButton"
                variant: "approve"
                text: root.card.approveLabel
                enabled: root.card.canApprove
                onClicked: root.decided(true)
            }
        }
    }
}
