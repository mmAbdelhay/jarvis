import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Network doctor (design: Doctor, spec §7): the fixed checklist on the left,
// networks in range and the current fix card on the right. Works with no model.
Item {
    id: root
    required property DoctorModel doctor
    required property CardModel card
    property string providerError: ""
    signal backRequested()
    signal decided(bool approve)

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        Rectangle {
            objectName: "doctorBanner"
            Layout.fillWidth: true
            implicitHeight: bannerRow.implicitHeight + 28
            color: Theme.warnBannerBg
            Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.warnBannerBorder }
            RowLayout {
                id: bannerRow
                anchors.fill: parent
                anchors.leftMargin: 28
                anchors.rightMargin: 28
                spacing: 12
                Icon { path: Icons.offline; color: Theme.warn; strokeWidth: 2; size: 20 }
                Text {
                    Layout.fillWidth: true
                    text: root.providerError.length > 0
                          ? "Can't reach the model: " + root.providerError + ". Network doctor works without a model."
                          : "Network doctor works without a model."
                    textFormat: Text.PlainText
                    color: Theme.warnBannerText
                    wrapMode: Text.Wrap
                }
                ActionButton {
                    objectName: "backButton"
                    variant: "ghost"
                    implicitHeight: 36
                    text: "Back to chat"
                    onClicked: root.backRequested()
                }
            }
        }

        Flickable {
            Layout.fillWidth: true
            Layout.fillHeight: true
            contentHeight: body.implicitHeight + 96
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            ColumnLayout {
                id: body
                width: Math.min(1040, root.width - 80)
                x: (root.width - width) / 2
                y: 48
                spacing: 32

                ColumnLayout {
                    spacing: 6
                    Text { text: "Network doctor"; color: Theme.text; font.pixelSize: 30; font.weight: Font.DemiBold }
                    Text { text: "Checks run one by one. Every fix asks you first."; color: Theme.muted }
                }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: 32

                    ColumnLayout {
                        Layout.preferredWidth: 400
                        Layout.alignment: Qt.AlignTop
                        spacing: 4
                        Repeater {
                            model: root.doctor
                            delegate: Rectangle {
                                id: stepRow
                                required property string stepId
                                required property string label
                                required property string status
                                required property string detail
                                required property int number
                                readonly property bool problem: status === "problem"
                                objectName: "step_" + stepId
                                Layout.fillWidth: true
                                implicitHeight: stepLine.implicitHeight + 24
                                radius: 10
                                color: problem ? Theme.approvalCard : "transparent"
                                border.color: problem ? Theme.approvalBorder : "transparent"

                                RowLayout {
                                    id: stepLine
                                    anchors.fill: parent
                                    anchors.margins: 12
                                    anchors.leftMargin: 14
                                    spacing: 12
                                    Text {
                                        objectName: "glyph"
                                        Layout.alignment: Qt.AlignTop
                                        Layout.minimumWidth: 14
                                        text: stepRow.status === "ok" || stepRow.status === "fixed" ? "✓"
                                            : stepRow.problem ? "!"
                                            : stepRow.status === "running" ? "…"
                                            : stepRow.status === "skipped" ? "–"
                                            : String(stepRow.number)
                                        color: stepRow.status === "ok" || stepRow.status === "fixed" || stepRow.status === "running" ? Theme.accent
                                             : stepRow.problem ? Theme.approval : Theme.mutedSoft
                                        font.family: Theme.mono
                                    }
                                    ColumnLayout {
                                        Layout.fillWidth: true
                                        spacing: 0
                                        Text {
                                            Layout.fillWidth: true
                                            text: stepRow.label
                                            textFormat: Text.PlainText
                                            wrapMode: Text.Wrap
                                            color: stepRow.status === "pending" || stepRow.status === "skipped" ? Theme.mutedSoft : Theme.text
                                            font.weight: stepRow.problem ? Font.Medium : Font.Normal
                                        }
                                        Text {
                                            Layout.fillWidth: true
                                            visible: text.length > 0
                                            text: stepRow.detail
                                            textFormat: Text.PlainText
                                            wrapMode: Text.Wrap
                                            color: stepRow.problem ? Theme.approvalMuted : Theme.mutedSoft
                                            font.pixelSize: Theme.fontSmall
                                        }
                                    }
                                    ActionButton {
                                        objectName: "skip_" + stepRow.stepId
                                        visible: stepRow.problem && !root.card.active
                                        variant: "ghost"
                                        implicitHeight: 36
                                        text: "Skip"
                                        onClicked: root.doctor.skip(stepRow.stepId)
                                    }
                                }
                            }
                        }
                    }

                    ColumnLayout {
                        Layout.fillWidth: true
                        Layout.alignment: Qt.AlignTop
                        spacing: 16

                        ColumnLayout {
                            objectName: "networksList"
                            Layout.fillWidth: true
                            visible: root.doctor.networks.length > 0 && !(root.card.active && root.card.exclusive)
                            spacing: 16
                            Text {
                                text: "NETWORKS IN RANGE"
                                color: Theme.mutedSoft
                                font.pixelSize: Theme.fontTiny
                                font.weight: Font.DemiBold
                                font.letterSpacing: 1
                            }
                            Rectangle {
                                Layout.fillWidth: true
                                implicitHeight: networkColumn.implicitHeight
                                radius: 12
                                color: "transparent"
                                border.color: Theme.borderStrong
                                clip: true
                                ColumnLayout {
                                    id: networkColumn
                                    width: parent.width
                                    spacing: 0
                                    Repeater {
                                        model: root.doctor.networks
                                        delegate: RowLayout {
                                            required property var modelData
                                            Layout.fillWidth: true
                                            Layout.margins: 14
                                            Layout.leftMargin: 16
                                            Layout.rightMargin: 16
                                            spacing: 12
                                            Text {
                                                Layout.fillWidth: true
                                                text: modelData.ssid
                                                textFormat: Text.PlainText
                                                color: Theme.text
                                                elide: Text.ElideRight
                                            }
                                            Text {
                                                text: (modelData.security.length > 0 ? modelData.security : "open") + " · " + modelData.strength
                                                      + (modelData.known ? " · saved" : "")
                                                textFormat: Text.PlainText
                                                color: Theme.muted
                                                font.pixelSize: Theme.fontSmall
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        ConfirmCard {
                            objectName: "doctorCard"
                            Layout.fillWidth: true
                            card: root.card
                            onDecided: (approve) => root.decided(approve)
                        }

                        Text {
                            objectName: "doctorOutcome"
                            Layout.fillWidth: true
                            visible: root.doctor.done.length > 0
                            text: root.doctor.done === "fixed"
                                  ? "The network works again."
                                  : "Jarvis couldn't fix this automatically. Try an Ethernet cable or your phone's hotspot, then run the doctor again."
                            color: root.doctor.done === "fixed" ? Theme.accent : Theme.warnBannerText
                            wrapMode: Text.Wrap
                        }
                        ActionButton {
                            objectName: "runAgain"
                            visible: root.doctor.done === "unfixed"
                            variant: "ghost"
                            text: "Run the checks again"
                            onClicked: root.doctor.start()
                        }
                    }
                }
            }
        }
    }
}
