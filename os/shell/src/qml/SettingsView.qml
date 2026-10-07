import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

// Provider settings: the setup form, prefilled from the active provider.
Item {
    id: root
    required property ProviderModel provider
    property bool doctorAvailable: false // sys:snapshot says offline (contracts §6.8)
    signal doctorRequested()

    Flickable {
        anchors.fill: parent
        contentHeight: column.implicitHeight + 112
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        ColumnLayout {
            id: column
            width: Math.min(760, root.width - 48)
            x: (root.width - width) / 2
            y: 56
            spacing: 28

            ColumnLayout {
                spacing: 6
                Text {
                    text: "Model provider"
                    color: Theme.text
                    font.pixelSize: 30
                    font.weight: Font.DemiBold
                }
                Text {
                    objectName: "currentProvider"
                    text: root.provider.hasActive
                          ? "Now: " + root.provider.activeModel + " · " + root.provider.activeLabel + ". Changes apply to your next message."
                          : "No provider yet."
                    textFormat: Text.PlainText
                    color: Theme.muted
                }
            }

            ProviderForm {
                Layout.fillWidth: true
                provider: root.provider
            }

            RowLayout {
                Layout.fillWidth: true
                ShellButton {
                    visible: root.provider.probeState === "error" && root.doctorAvailable
                    variant: "ghost"
                    text: "Open Network doctor"
                    onClicked: root.doctorRequested()
                }
                Item { Layout.fillWidth: true }
                ShellButton {
                    objectName: "saveButton"
                    variant: "primary"
                    text: root.provider.probeState === "saving" ? "Saving…" : "Save"
                    enabled: root.provider.canSave
                    onClicked: root.provider.save()
                }
            }
        }
    }
}
