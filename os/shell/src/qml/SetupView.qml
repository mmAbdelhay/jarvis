import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// First boot (design: Setup): pick and check a provider, then start.
Item {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    required property ProviderModel provider
    property AccountsModel accounts: null
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
                    Text { text: qsTr("Jarvis"); color: Theme.text; font.weight: Font.DemiBold; font.letterSpacing: 0.6 }
                }
                Text {
                    text: qsTr("Where should Jarvis think?")
                    color: Theme.text
                    font.pixelSize: 34
                    font.weight: Font.DemiBold
                }
                Text {
                    text: qsTr("Pick the model that runs Jarvis. You can change it any time in Settings.")
                    color: Theme.muted
                }
            }

            ProviderForm {
                Layout.fillWidth: true
                provider: root.provider
                accounts: root.accounts
            }

            RowLayout {
                Layout.fillWidth: true
                spacing: 12
                ActionButton {
                    objectName: "setupDoctor"
                    visible: root.provider.probeState === "error" && root.doctorAvailable
                    variant: "ghost"
                    text: qsTr("No internet? Open Network doctor")
                    onClicked: root.doctorRequested()
                }
                Item { Layout.fillWidth: true }
                ActionButton {
                    objectName: "startButton"
                    variant: "primary"
                    implicitHeight: 48
                    text: root.provider.probeState === "saving" ? qsTr("Saving…") : qsTr("Start using Jarvis")
                    enabled: root.provider.canSave
                    onClicked: root.provider.save()
                }
            }
        }
    }
}
