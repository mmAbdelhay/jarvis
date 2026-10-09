import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic
import Jarvis.UI
import Jarvis.Shell

// The docked Jarvis panel of classic mode (Rafiq M4 contracts §2). It is the
// shell's own ChatView over the shell's own ShellController, so cards, lock
// gating and the backup-model banner behave exactly as in the full shell.
// Without jarvisd it says so; Apps, Terminal and Files keep working.
Rectangle {
    id: root
    required property ClassicController controller
    readonly property ShellController shell: controller.shell
    readonly property bool connected: shell !== null && shell.connection === "open"

    function focusComposer() { chat.focusComposer() }

    color: Theme.bg
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true

    Rectangle { anchors.left: parent.left; width: 1; height: parent.height; color: Theme.border }

    ColumnLayout {
        anchors.fill: parent
        spacing: 0

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: 16
            spacing: 10
            Icon { path: Icons.logo; color: Theme.accent; size: 22 }
            Text {
                Layout.fillWidth: true
                text: qsTr("Jarvis")
                color: Theme.text
                font.pixelSize: 17
                font.weight: Font.DemiBold
            }
            AbstractButton {
                objectName: "closeChat"
                implicitWidth: 36
                implicitHeight: 36
                Accessible.name: qsTr("Close")
                Accessible.role: Accessible.Button
                onClicked: root.controller.closeChat()
                contentItem: Text {
                    text: "×"
                    color: Theme.textSoft
                    font.pixelSize: 20
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
                background: Rectangle { radius: Theme.radiusControl; color: parent.hovered ? Theme.surfaceRaised : "transparent" }
            }
        }

        Banner {
            objectName: "chatBanner"
            Layout.fillWidth: true
            visible: root.connected && root.shell.bannerText.length > 0
            text: root.connected ? root.shell.bannerText : ""
            showDoctor: false
            showSettings: root.connected && !root.shell.providerReachable
            onSettingsRequested: root.controller.openSettings()
        }

        Text {
            objectName: "chatUnavailable"
            Layout.fillWidth: true
            Layout.margins: 24
            visible: !root.connected
            text: qsTr("Jarvis isn't running right now. Apps, Terminal and Files still work.")
            wrapMode: Text.Wrap
            color: Theme.muted
        }

        ActionButton {
            objectName: "setupInSettings"
            Layout.margins: 24
            visible: root.connected && root.shell.view === "setup"
            variant: "primary"
            text: qsTr("Set up a model in Settings")
            onClicked: root.controller.openSettings()
        }

        ChatView {
            id: chat
            objectName: "classicChat"
            Layout.fillWidth: true
            Layout.fillHeight: true
            visible: root.connected && root.shell.view !== "setup"
            conversation: root.shell.conversation
            card: root.shell.chatCard
            onSubmit: (text) => root.shell.sendPrompt(text)
            onStopRequested: root.shell.stop()
            onDecided: (approve) => root.shell.decide(root.shell.chatCard, approve)
        }

        Item { Layout.fillHeight: true; visible: !chat.visible }
    }
}
