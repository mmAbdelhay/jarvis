import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// qsTr("This machine") side panel (design: Main), fed by the sys:snapshot push
// (contracts §6.8): network, model, memory, disk, failed services, then the
// recent actions from the activity log.
Rectangle {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property ShellController shell
    readonly property SystemModel system: shell.system

    implicitWidth: 320
    color: Theme.surfaceDeep
    Rectangle { anchors.left: parent.left; width: 1; height: parent.height; color: Theme.border }

    component Fact: ColumnLayout {
        id: fact
        property string name
        property string value
        property string detail
        property bool warn: false
        property bool mono: false
        property real fraction: -1
        Layout.fillWidth: true
        spacing: 4
        RowLayout {
            Layout.fillWidth: true
            Text { text: fact.name; color: Theme.muted; font.pixelSize: 14 }
            Item { Layout.fillWidth: true }
            Text {
                objectName: "value"
                text: fact.value
                textFormat: Text.PlainText
                color: fact.warn ? Theme.warn : Theme.text
                font.family: fact.mono ? Theme.mono : Theme.sans
                font.pixelSize: fact.mono ? Theme.fontSmall : 14
                font.weight: fact.warn ? Font.Medium : Font.Normal
                elide: Text.ElideRight
            }
        }
        Rectangle {
            Layout.fillWidth: true
            visible: fact.fraction >= 0
            implicitHeight: 6
            radius: 3
            color: Theme.surfaceRaised
            Rectangle {
                width: parent.width * Math.max(0, Math.min(1, fact.fraction))
                height: parent.height
                radius: 3
                color: Theme.accent
            }
        }
        Text {
            Layout.fillWidth: true
            visible: text.length > 0
            text: fact.detail
            textFormat: Text.PlainText
            color: Theme.mutedSoft
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.Wrap
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.leftMargin: 22
        anchors.rightMargin: 22
        anchors.topMargin: 24
        anchors.bottomMargin: 24
        spacing: 22

        Text {
            text: qsTr("THIS MACHINE")
            color: Theme.mutedSoft
            font.pixelSize: Theme.fontTiny
            font.weight: Font.DemiBold
            font.letterSpacing: 1
        }

        Fact {
            objectName: "panelNetwork"
            name: qsTr("Network")
            value: root.system.known ? root.system.networkText : "…"
            warn: root.system.known && !root.system.online
            detail: root.system.known ? root.system.networkDetail : ""
        }
        Fact {
            objectName: "panelModel"
            name: qsTr("Model")
            value: root.system.hasModel ? root.system.modelName
                 : root.shell.provider.hasActive ? root.shell.provider.activeModel : qsTr("Not set up")
            warn: !root.shell.providerReachable
            detail: !root.shell.providerReachable && root.shell.providerError.length > 0
                    ? qsTr("Unreachable: %1").arg(root.shell.providerError)
                    : root.system.modelDownloadText.length > 0 ? root.system.modelDownloadText
                    : root.system.hasModel ? root.system.modelDetail : root.shell.provider.activeLabel
            fraction: root.system.modelDownloadState === "downloading" ? root.system.modelDownloadPercent / 100 : -1
        }
        Fact {
            objectName: "panelMemory"
            visible: root.system.known
            name: qsTr("Memory")
            mono: true
            value: root.system.memoryText
            fraction: root.system.memoryFraction
        }
        Fact {
            objectName: "panelDisk"
            visible: root.system.known
            name: qsTr("Disk")
            mono: true
            value: root.system.diskText
            fraction: root.system.diskFraction
        }
        Fact {
            objectName: "panelFailed"
            visible: root.system.known
            name: qsTr("Failed services")
            value: String(root.system.failedUnits.length)
            warn: root.system.failedUnits.length > 0
            detail: root.system.failedUnits.join("\n")
        }
        Fact {
            objectName: "panelUpdates"
            visible: root.system.known
            name: qsTr("Updates")
            value: root.system.updatesCount > 0 ? root.system.updatesText : qsTr("Up to date")
            warn: root.system.updatesSecurity > 0
        }
        RowLayout {
            Layout.fillWidth: true
            visible: root.system.known
            spacing: 8
            AbstractButton {
                objectName: "checkUpdates"
                enabled: !root.shell.updatesChecking
                text: root.shell.updatesChecking ? qsTr("Checking…") : qsTr("Check for updates")
                Accessible.name: text
                contentItem: Text { text: parent.text; color: Theme.accent; font.pixelSize: Theme.fontSmall }
                background: null
                onClicked: root.shell.checkForUpdates()
            }
            Text {
                objectName: "updatesNote"
                Layout.fillWidth: true
                text: root.shell.updatesNote
                textFormat: Text.PlainText
                color: Theme.mutedSoft
                font.pixelSize: Theme.fontSmall
                elide: Text.ElideRight
            }
        }

        Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: Theme.border }

        ColumnLayout {
            Layout.fillWidth: true
            spacing: 10
            Text {
                text: qsTr("RECENT ACTIONS")
                color: Theme.mutedSoft
                font.pixelSize: Theme.fontTiny
                font.weight: Font.DemiBold
                font.letterSpacing: 1
            }
            Repeater {
                model: root.shell.audit.recent
                delegate: RowLayout {
                    required property var modelData
                    Layout.fillWidth: true
                    Text {
                        Layout.fillWidth: true
                        text: modelData.text
                        textFormat: Text.PlainText
                        color: Theme.text
                        font.pixelSize: Theme.fontSmall
                        elide: Text.ElideRight
                    }
                    Text {
                        text: modelData.timeText
                        color: Theme.mutedSoft
                        font.family: Theme.mono
                        font.pixelSize: Theme.fontSmall
                    }
                }
            }
            Text {
                visible: root.shell.audit.recent.length === 0
                text: qsTr("Nothing yet.")
                color: Theme.mutedSoft
                font.pixelSize: Theme.fontSmall
            }
            AbstractButton {
                objectName: "openActivityLog"
                text: qsTr("Open activity log")
                Accessible.name: text
                contentItem: Text { text: qsTr("Open activity log"); color: Theme.accent; font.pixelSize: Theme.fontSmall }
                background: null
                onClicked: root.shell.showView("audit")
            }
        }

        Item { Layout.fillHeight: true }
    }
}
