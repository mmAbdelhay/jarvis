import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Step 5 (design: "Ready to install"). Shows the backend's InstallPlan.summary
// verbatim, one row per line, as plain text. Nothing has touched a disk yet.
ColumnLayout {
    id: root
    required property InstallerModel installer

    spacing: 20

    ScreenTitle {
        Layout.fillWidth: true
        title: qsTr("Ready to install")
    }

    Rectangle {
        Layout.fillWidth: true
        implicitHeight: lines.implicitHeight
        radius: 12
        color: "transparent"
        border.color: Theme.border
        ColumnLayout {
            id: lines
            anchors.left: parent.left
            anchors.right: parent.right
            spacing: 0
            Repeater {
                model: root.installer.summary
                delegate: ColumnLayout {
                    required property string modelData
                    required property int index
                    Layout.fillWidth: true
                    spacing: 0
                    Text {
                        objectName: "summaryLine_" + index
                        Layout.fillWidth: true
                        Layout.leftMargin: 18
                        Layout.rightMargin: 18
                        Layout.topMargin: 14
                        Layout.bottomMargin: 14
                        text: modelData
                        textFormat: Text.PlainText
                        color: Theme.text
                        wrapMode: Text.Wrap
                    }
                    Rectangle {
                        Layout.fillWidth: true
                        visible: index < root.installer.summary.length - 1
                        implicitHeight: 1
                        color: Theme.surfaceRaised
                    }
                }
            }
        }
    }

    ColumnLayout {
        objectName: "diskAfter"
        Layout.fillWidth: true
        visible: root.installer.diskAfter.length > 0
        spacing: 4
        Text { text: qsTr("Disk after install"); color: Theme.muted; font.pixelSize: Theme.fontSmall }
        RowLayout {
            Layout.fillWidth: true
            spacing: 2
            Repeater {
                model: root.installer.diskAfter
                delegate: Rectangle {
                    required property var modelData
                    Layout.fillWidth: true
                    Layout.preferredWidth: Math.max(1, modelData.fraction * 1000)
                    implicitHeight: 28
                    radius: 6
                    color: modelData.encrypted ? Theme.accentTintBorder : Theme.otherOs
                    Text {
                        anchors.left: parent.left
                        anchors.leftMargin: 10
                        width: parent.width - 12
                        anchors.verticalCenter: parent.verticalCenter
                        text: modelData.label + " · " + modelData.sizeText + (modelData.encrypted ? " · " + qsTr("encrypted") : "")
                        textFormat: Text.PlainText
                        color: modelData.encrypted ? Theme.accentTintText : Theme.otherOsText
                        font.pixelSize: Theme.fontTiny
                        elide: Text.ElideRight
                    }
                }
            }
        }
    }

    Card {
        objectName: "installNotice"
        Layout.fillWidth: true
        tone: "approval"
        RowLayout {
            Layout.fillWidth: true
            spacing: 12
            Icon { Layout.alignment: Qt.AlignTop; path: Icons.shield; color: Theme.approval; strokeWidth: 2; size: 20 }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 4
                Text {
                    objectName: "noticeText"
                    Layout.fillWidth: true
                    text: qsTr("Changes to the disk start when you press Install.")
                    color: Theme.text
                    wrapMode: Text.Wrap
                }
                Repeater {
                    model: root.installer.warnings
                    delegate: Text {
                        required property string modelData
                        required property int index
                        objectName: "warning_" + index
                        Layout.fillWidth: true
                        text: modelData
                        textFormat: Text.PlainText
                        color: Theme.text
                        wrapMode: Text.Wrap
                    }
                }
            }
        }
    }
}
