import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Settings → Memory (design §3.9): what Jarvis remembers, one-by-one forget,
// and forget everything behind a second click.
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property MemoryModel memory
    property bool confirmingClear: false

    spacing: 14

    Text {
        Layout.fillWidth: true
        text: qsTr("Jarvis keeps short summaries of your conversations and a few facts, encrypted on this computer. They only leave it inside your own messages to your model provider.")
        wrapMode: Text.Wrap
        color: Theme.muted
    }
    Text {
        objectName: "memoryError"
        Layout.fillWidth: true
        visible: root.memory.error !== ""
        text: root.memory.error
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.warn
    }
    Text {
        objectName: "memoryEmpty"
        visible: root.memory.known && root.memory.count === 0 && root.memory.error === ""
        text: qsTr("Jarvis hasn't remembered anything yet.")
        color: Theme.muted
    }

    Repeater {
        model: root.memory
        delegate: Rectangle {
            id: memoryRow
            required property int index
            required property string memoryId
            required property string kindLabel
            required property string text
            required property string timeText
            objectName: "memory_" + memoryId
            Layout.fillWidth: true
            implicitHeight: memoryLayout.implicitHeight + 24
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: Theme.border

            RowLayout {
                id: memoryLayout
                anchors.fill: parent
                anchors.margins: 12
                spacing: 12
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4
                    Text {
                        text: memoryRow.kindLabel + " · " + memoryRow.timeText
                        color: Theme.mutedSoft
                        font.pixelSize: Theme.fontSmall
                    }
                    Text {
                        objectName: "memoryText_" + memoryRow.memoryId
                        Layout.fillWidth: true
                        text: memoryRow.text
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.text
                    }
                }
                ActionButton {
                    objectName: "forget_" + memoryRow.memoryId
                    text: qsTr("Forget")
                    Accessible.name: qsTr("Forget this %1").arg(memoryRow.kindLabel)
                    onClicked: root.memory.remove(memoryRow.index)
                }
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        visible: root.memory.count > 0
        spacing: 12
        Text {
            Layout.fillWidth: true
            visible: root.confirmingClear
            text: qsTr("Forget everything Jarvis remembers? This can't be undone.")
            wrapMode: Text.Wrap
            color: Theme.warnBannerText
        }
        Item { Layout.fillWidth: true; visible: !root.confirmingClear }
        ActionButton {
            objectName: "forgetAll"
            visible: !root.confirmingClear
            text: qsTr("Forget everything")
            onClicked: root.confirmingClear = true
        }
        ActionButton {
            objectName: "cancelForgetAll"
            visible: root.confirmingClear
            text: qsTr("Keep")
            onClicked: root.confirmingClear = false
        }
        ActionButton {
            objectName: "confirmForgetAll"
            visible: root.confirmingClear
            variant: "primary"
            text: qsTr("Forget everything")
            onClicked: {
                root.confirmingClear = false
                root.memory.clearAll()
            }
        }
    }
}
