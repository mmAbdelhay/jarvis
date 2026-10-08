import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Settings → Tools (design §3.7): tool servers from the signed registry, with
// their trust tier and permissions. Install and Remove ask Jarvis in chat;
// the change itself arrives as an approval card.
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property RegistryModel registry

    spacing: 14

    Text {
        Layout.fillWidth: true
        text: qsTr("Tool servers give Jarvis new abilities. Installing or removing one happens in chat, with an approval card.")
        wrapMode: Text.Wrap
        color: Theme.muted
    }
    TextField {
        objectName: "toolFilter"
        Layout.fillWidth: true
        placeholderText: qsTr("Search tools")
        color: Theme.text
        placeholderTextColor: Theme.mutedSoft
        background: Rectangle { radius: Theme.radiusControl; color: Theme.surfaceDeep; border.color: Theme.border }
        onTextChanged: root.registry.filter = text
    }
    Text {
        objectName: "toolsError"
        Layout.fillWidth: true
        visible: root.registry.error !== ""
        text: root.registry.error
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.warn
    }
    Text {
        objectName: "toolsEmpty"
        visible: root.registry.known && root.registry.count === 0 && root.registry.error === ""
        text: root.registry.filter === "" ? qsTr("No tool servers are listed yet.") : qsTr("No tool matches that search.")
        color: Theme.muted
    }

    Repeater {
        model: root.registry
        delegate: Rectangle {
            id: toolRow
            required property int index
            required property string entryId
            required property string name
            required property string description
            required property string tier
            required property string tierLabel
            required property string tierDetail
            required property string version
            required property string installedVersion
            required property string installState
            required property string permissionsText
            required property string toolsText
            objectName: "tool_" + entryId
            Layout.fillWidth: true
            implicitHeight: toolLayout.implicitHeight + 28
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: tier === "community" ? Theme.warnBannerBorder : Theme.border

            RowLayout {
                id: toolLayout
                anchors.fill: parent
                anchors.margins: 14
                spacing: 14
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 4
                    RowLayout {
                        spacing: 8
                        Text {
                            objectName: "toolName_" + toolRow.entryId
                            text: toolRow.name
                            textFormat: Text.PlainText
                            color: Theme.text
                            font.weight: Font.DemiBold
                        }
                        Rectangle {
                            implicitWidth: tierText.implicitWidth + 16
                            implicitHeight: tierText.implicitHeight + 6
                            radius: height / 2
                            color: toolRow.tier === "community" ? Theme.failedChipBg : Theme.accentTint
                            Text {
                                id: tierText
                                anchors.centerIn: parent
                                text: toolRow.tierLabel
                                textFormat: Text.PlainText
                                color: toolRow.tier === "community" ? Theme.failedChipText : Theme.accentTintText
                                font.pixelSize: Theme.fontTiny
                            }
                        }
                        Text {
                            text: toolRow.installState === "update"
                                  ? qsTr("%1 → %2").arg(toolRow.installedVersion).arg(toolRow.version)
                                  : toolRow.version
                            textFormat: Text.PlainText
                            color: Theme.mutedSoft
                            font.pixelSize: Theme.fontSmall
                        }
                    }
                    Text {
                        objectName: "toolDescription_" + toolRow.entryId
                        Layout.fillWidth: true
                        visible: toolRow.description !== ""
                        text: toolRow.description
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.textSoft
                    }
                    Text {
                        objectName: "tierDetail_" + toolRow.entryId
                        Layout.fillWidth: true
                        text: toolRow.tierDetail
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.muted
                        font.pixelSize: Theme.fontSmall
                    }
                    Text {
                        Layout.fillWidth: true
                        text: toolRow.permissionsText
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.muted
                        font.pixelSize: Theme.fontSmall
                    }
                    Text {
                        Layout.fillWidth: true
                        visible: toolRow.toolsText !== ""
                        text: qsTr("Tools: %1").arg(toolRow.toolsText)
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.mutedSoft
                        font.pixelSize: Theme.fontSmall
                    }
                }
                ColumnLayout {
                    spacing: 8
                    ActionButton {
                        objectName: "install_" + toolRow.entryId
                        visible: toolRow.installState !== "installed"
                        variant: "primary"
                        text: toolRow.installState === "update" ? qsTr("Update") : qsTr("Install")
                        onClicked: root.registry.install(toolRow.index)
                    }
                    ActionButton {
                        objectName: "remove_" + toolRow.entryId
                        visible: toolRow.installState !== "available"
                        text: qsTr("Remove")
                        onClicked: root.registry.remove(toolRow.index)
                    }
                }
            }
        }
    }
}
