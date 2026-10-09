import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI

// Model providers in failover order (design §3.5): Jarvis tries the first one,
// and moves on to the next when one is unreachable, busy or failing. Cloud
// fallback from a local/network provider is opt-in (privacy ruling).
ColumnLayout {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property ProviderModel provider
    required property ProviderListModel providers
    property bool doctorAvailable: false
    property bool editing: false
    signal doctorRequested()

    spacing: 18

    Connections {
        target: root.provider
        function onSaved() { root.editing = false }
    }

    Text {
        Layout.fillWidth: true
        text: qsTr("Jarvis tries these in order. If one can't answer, it moves to the next for that message, and starts from the top again on your next one.")
        wrapMode: Text.Wrap
        color: Theme.muted
    }

    Repeater {
        model: root.providers
        delegate: Rectangle {
            id: rowItem
            required property int index
            required property string providerId
            required property string modelName
            required property string label
            required property bool active
            required property string error
            objectName: "providerRow_" + providerId
            Layout.fillWidth: true
            implicitHeight: rowLayout.implicitHeight + 24
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: active ? Theme.accentTintBorder : Theme.border

            RowLayout {
                id: rowLayout
                anchors.fill: parent
                anchors.margins: 12
                spacing: 10
                Text { text: (rowItem.index + 1) + "."; color: Theme.muted }
                ColumnLayout {
                    Layout.fillWidth: true
                    spacing: 2
                    Text {
                        Layout.fillWidth: true
                        text: rowItem.modelName + " · " + rowItem.label
                        textFormat: Text.PlainText
                        elide: Text.ElideRight
                        color: Theme.text
                    }
                    Text {
                        visible: rowItem.active
                        text: qsTr("In use now")
                        color: Theme.accent
                        font.pixelSize: Theme.fontSmall
                    }
                    Text {
                        objectName: "providerError_" + rowItem.providerId
                        Layout.fillWidth: true
                        visible: rowItem.error !== ""
                        text: rowItem.error
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: Theme.warn
                        font.pixelSize: Theme.fontSmall
                    }
                }
                ActionButton {
                    objectName: "moveUp_" + rowItem.providerId
                    text: qsTr("Up")
                    Accessible.name: qsTr("Try %1 earlier").arg(rowItem.modelName)
                    enabled: rowItem.index > 0 && !root.providers.saving
                    onClicked: root.providers.moveUp(rowItem.index)
                }
                ActionButton {
                    objectName: "moveDown_" + rowItem.providerId
                    text: qsTr("Down")
                    Accessible.name: qsTr("Try %1 later").arg(rowItem.modelName)
                    enabled: rowItem.index < root.providers.count - 1 && !root.providers.saving
                    onClicked: root.providers.moveDown(rowItem.index)
                }
                ActionButton {
                    objectName: "edit_" + rowItem.providerId
                    text: qsTr("Edit")
                    onClicked: {
                        root.provider.editProvider(root.providers.config(rowItem.index))
                        root.editing = true
                    }
                }
                ActionButton {
                    objectName: "remove_" + rowItem.providerId
                    text: qsTr("Remove")
                    enabled: root.providers.count > 1 && !root.providers.saving
                    onClicked: root.providers.remove(rowItem.index)
                }
            }
        }
    }

    CheckRow {
        objectName: "cloudFallback"
        Layout.fillWidth: true
        text: qsTr("Allow cloud fallback")
        checked: root.providers.allowCloudFallback
        onToggled: root.providers.allowCloudFallback = checked
        Binding on checked {
            value: root.providers.allowCloudFallback
            restoreMode: Binding.RestoreNone
        }
    }
    Text {
        Layout.fillWidth: true
        text: qsTr("When a provider on this computer or your network fails, Jarvis may use a cloud provider from this list. Off keeps your messages on your own machines.")
        wrapMode: Text.Wrap
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 12
        Text {
            objectName: "listStatus"
            Layout.fillWidth: true
            text: root.providers.statusText
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: Theme.muted
        }
        ActionButton {
            objectName: "addProvider"
            text: qsTr("Add a provider")
            onClicked: {
                root.provider.startNew()
                root.editing = true
            }
        }
        ActionButton {
            objectName: "saveOrder"
            variant: "primary"
            text: root.providers.saving ? qsTr("Saving…") : qsTr("Save changes")
            enabled: root.providers.dirty && !root.providers.saving
            onClicked: root.providers.save()
        }
    }

    ColumnLayout {
        objectName: "providerEditor"
        Layout.fillWidth: true
        visible: root.editing
        spacing: 18
        Text {
            text: root.provider.editingId === "" ? qsTr("Add a provider") : qsTr("Edit %1").arg(root.provider.editingId)
            textFormat: Text.PlainText
            color: Theme.text
            font.pixelSize: 22
            font.weight: Font.DemiBold
        }
        ProviderForm {
            Layout.fillWidth: true
            provider: root.provider
        }
        RowLayout {
            Layout.fillWidth: true
            ActionButton {
                visible: root.provider.probeState === "error" && root.doctorAvailable
                text: qsTr("Open Network doctor")
                onClicked: root.doctorRequested()
            }
            Item { Layout.fillWidth: true }
            ActionButton {
                objectName: "cancelEdit"
                text: qsTr("Cancel")
                onClicked: root.editing = false
            }
            ActionButton {
                objectName: "saveButton"
                variant: "primary"
                text: root.provider.probeState === "saving" ? qsTr("Saving…") : qsTr("Save provider")
                enabled: root.provider.canSave
                onClicked: root.provider.save()
            }
        }
    }
}
