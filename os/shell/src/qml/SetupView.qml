import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

// First boot (design: Setup): pick and check a provider, then start.
Item {
    id: root
    required property ProviderModel provider
    property bool doctorAvailable: false // sys:snapshot says offline (contracts §6.8)
    signal doctorRequested()

    Flickable {
        anchors.fill: parent
        contentHeight: column.implicitHeight + 96
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        ColumnLayout {
            id: column
            width: Math.min(760, root.width - 48)
            x: (root.width - width) / 2
            y: Math.max(48, (root.height - implicitHeight) / 2)
            spacing: 28

            ColumnLayout {
                spacing: 10
                RowLayout {
                    spacing: 10
                    Icon { path: Icons.logo; color: Theme.accent; size: 28 }
                    Text { text: "Jarvis"; color: Theme.text; font.weight: Font.DemiBold; font.letterSpacing: 0.6 }
                }
                Text {
                    text: "Where should Jarvis think?"
                    color: Theme.text
                    font.pixelSize: 34
                    font.weight: Font.DemiBold
                }
                Text {
                    text: "Pick the model that runs Jarvis. You can change it any time in Settings."
                    color: Theme.muted
                }
            }

            ProviderForm {
                Layout.fillWidth: true
                provider: root.provider
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 12
                ShellButton {
                    objectName: "setupDoctor"
                    visible: root.provider.probeState === "error" && root.doctorAvailable
                    variant: "ghost"
                    text: "No internet? Open Network doctor"
                    onClicked: root.doctorRequested()
                }
                Item { Layout.fillWidth: true }
                ShellButton {
                    objectName: "startButton"
                    variant: "primary"
                    implicitHeight: 48
                    text: root.provider.probeState === "saving" ? "Saving…" : "Start using Jarvis"
                    enabled: root.provider.canSave
                    onClicked: root.provider.save()
                }
            }
        }
    }
}
