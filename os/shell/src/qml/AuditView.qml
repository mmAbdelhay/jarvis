import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Activity log (design: Audit): everything Jarvis asked to change and what
// the user decided, newest first, from ~/.local/state/jarvis/audit.jsonl.
Item {
    id: root
    required property AuditModel audit
    signal backRequested()

    ColumnLayout {
        width: Math.min(1120, root.width - 80)
        height: root.height - 112
        x: (root.width - width) / 2
        y: 56
        spacing: 24

        RowLayout {
            Layout.fillWidth: true
            spacing: 24
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 6
                AbstractButton {
                    objectName: "backLink"
                    text: "← Chat"
                    Accessible.name: "Back to chat"
                    contentItem: Text { text: "← Chat"; color: Theme.accent; font.pixelSize: 14 }
                    background: null
                    onClicked: root.backRequested()
                }
                Text { text: "Activity log"; color: Theme.text; font.pixelSize: 30; font.weight: Font.DemiBold }
                Text { text: "Everything Jarvis asked to change, and what you decided."; color: Theme.muted }
            }
            RowLayout {
                Layout.alignment: Qt.AlignBottom
                spacing: 8
                Repeater {
                    model: [{ id: "all", label: "All" }, { id: "approved", label: "Approved" },
                            { id: "denied", label: "Denied" }, { id: "failed", label: "Failed" }]
                    delegate: AbstractButton {
                        id: chip
                        required property var modelData
                        readonly property bool selected: root.audit.filter === modelData.id
                        objectName: "filter_" + modelData.id
                        implicitHeight: 36
                        implicitWidth: chipText.implicitWidth + 28
                        Accessible.role: Accessible.RadioButton
                        Accessible.checked: selected
                        Accessible.name: modelData.label
                        contentItem: Text {
                            id: chipText
                            text: chip.modelData.label
                            horizontalAlignment: Text.AlignHCenter
                            verticalAlignment: Text.AlignVCenter
                            color: chip.selected ? Theme.accentTintText : Theme.textSoft
                            font.pixelSize: 14
                        }
                        background: Rectangle {
                            radius: 999
                            color: chip.selected ? Theme.accentTint : "transparent"
                            border.color: chip.selected ? Theme.accent : Theme.borderStrong
                        }
                        onClicked: root.audit.filter = modelData.id
                    }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            radius: 12
            color: "transparent"
            border.color: Theme.border
            clip: true

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 1
                spacing: 0

                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: 44
                    color: Theme.tableHeader
                    RowLayout {
                        anchors.fill: parent
                        anchors.leftMargin: 16
                        anchors.rightMargin: 16
                        spacing: 16
                        Text { Layout.preferredWidth: 90; text: "Time"; color: Theme.mutedSoft; font.pixelSize: 14; font.weight: Font.Medium }
                        Text { Layout.fillWidth: true; text: "Action"; color: Theme.mutedSoft; font.pixelSize: 14; font.weight: Font.Medium }
                        Text { Layout.preferredWidth: 200; text: "Tool"; color: Theme.mutedSoft; font.pixelSize: 14; font.weight: Font.Medium }
                        Text { Layout.preferredWidth: 110; text: "Approved on"; color: Theme.mutedSoft; font.pixelSize: 14; font.weight: Font.Medium }
                        Text { Layout.preferredWidth: 120; text: "Decision"; color: Theme.mutedSoft; font.pixelSize: 14; font.weight: Font.Medium }
                        Text { Layout.preferredWidth: 200; text: "Result"; color: Theme.mutedSoft; font.pixelSize: 14; font.weight: Font.Medium }
                    }
                }

                ListView {
                    id: list
                    objectName: "auditList"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    model: root.audit
                    boundsBehavior: Flickable.StopAtBounds
                    ScrollBar.vertical: ScrollBar {}

                    delegate: Rectangle {
                        id: row
                        required property int index
                        required property string timeText
                        required property string title
                        required property string tool
                        required property string via
                        required property string decision
                        required property string decisionLabel
                        required property string resultLabel
                        required property bool failed
                        width: list.width
                        implicitHeight: rowLine.implicitHeight + 28
                        color: "transparent"
                        Rectangle { width: parent.width; height: 1; color: Theme.surfaceRaised }
                        RowLayout {
                            id: rowLine
                            anchors.fill: parent
                            anchors.leftMargin: 16
                            anchors.rightMargin: 16
                            spacing: 16
                            Text { Layout.preferredWidth: 90; text: row.timeText; color: Theme.muted; font.family: Theme.mono; font.pixelSize: Theme.fontSmall }
                            Text { Layout.fillWidth: true; text: row.title; textFormat: Text.PlainText; color: Theme.text; font.pixelSize: 14; wrapMode: Text.Wrap }
                            Text { Layout.preferredWidth: 200; text: row.tool; textFormat: Text.PlainText; color: Theme.textSoft; font.family: Theme.mono; font.pixelSize: Theme.fontSmall; elide: Text.ElideRight }
                            Text { Layout.preferredWidth: 110; text: row.via; color: Theme.muted; font.pixelSize: 14 }
                            Item {
                                Layout.preferredWidth: 120
                                implicitHeight: chipBox.implicitHeight
                                Rectangle {
                                    id: chipBox
                                    implicitWidth: chipLabel.implicitWidth + 20
                                    implicitHeight: chipLabel.implicitHeight + 4
                                    radius: 999
                                    color: row.failed ? Theme.failedChipBg : row.decision === "approved" ? Theme.accentTint : Theme.surfaceRaised
                                    Text {
                                        id: chipLabel
                                        objectName: "chip_" + row.index
                                        anchors.centerIn: parent
                                        text: row.decisionLabel
                                        color: row.failed ? Theme.failedChipText : row.decision === "approved" ? Theme.accentHover : Theme.textSoft
                                        font.pixelSize: Theme.fontSmall
                                    }
                                }
                            }
                            Text { Layout.preferredWidth: 200; text: row.resultLabel; textFormat: Text.PlainText; color: Theme.muted; font.pixelSize: 14; wrapMode: Text.Wrap }
                        }
                    }

                    footer: Item {
                        width: list.width
                        implicitHeight: root.audit.hasMore ? 64 : 0
                        ActionButton {
                            objectName: "loadMore"
                            anchors.centerIn: parent
                            visible: root.audit.hasMore
                            variant: "ghost"
                            text: root.audit.loading ? "Loading…" : "Load older entries"
                            enabled: !root.audit.loading
                            onClicked: root.audit.loadMore()
                        }
                    }
                }
            }

            Text {
                objectName: "emptyText"
                anchors.centerIn: parent
                visible: list.count === 0 && !root.audit.loading
                text: root.audit.filter === "all"
                      ? "Nothing yet. When Jarvis asks to change something, it shows up here."
                      : "Nothing matches this filter."
                color: Theme.muted
            }
        }

        Text {
            text: "Stored on this computer in ~/.local/state/jarvis/audit.jsonl. Passwords are never written here."
            color: Theme.mutedSoft
            font.pixelSize: Theme.fontSmall
        }
    }
}
