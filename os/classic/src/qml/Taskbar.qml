import QtQuick
import QtQuick.Layouts
import Jarvis.UI
import Jarvis.Shell

// The classic taskbar (design Fallback.dc.html; Rafiq M4 contracts §2): Apps,
// Terminal, Files, Settings, then status (classic-mode note, launch notices,
// network, clock) and the Jarvis button that docks the chat panel.
Rectangle {
    id: root
    required property ClassicController controller
    readonly property ShellController shell: controller.shell
    property date now: new Date()

    implicitHeight: 48
    color: Theme.surfaceDeep
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true

    Rectangle { anchors.top: parent.top; width: parent.width; height: 1; color: Theme.border }
    Timer { interval: 1000; running: true; repeat: true; onTriggered: root.now = new Date() }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 8
        anchors.rightMargin: 8
        spacing: 4

        TaskbarButton {
            objectName: "appsButton"
            text: qsTr("Apps")
            iconPath: Icons.apps
            active: root.controller.appsOpen
            onClicked: root.controller.toggleApps()
        }
        TaskbarButton { objectName: "terminalButton"; text: qsTr("Terminal"); iconPath: Icons.terminal; onClicked: root.controller.openTerminal() }
        TaskbarButton { objectName: "filesButton"; text: qsTr("Files"); iconPath: Icons.folder; onClicked: root.controller.openFiles() }
        TaskbarButton { objectName: "settingsButton"; text: qsTr("Settings"); iconPath: Icons.settings; onClicked: root.controller.openSettings() }

        Item { Layout.fillWidth: true }

        Text {
            objectName: "noticeText"
            Layout.maximumWidth: 420
            visible: text.length > 0
            text: root.controller.notice
            textFormat: Text.PlainText
            elide: Text.ElideRight
            color: Theme.warn
            font.pixelSize: Theme.fontSmall
            MouseArea { anchors.fill: parent; onClicked: root.controller.dismissNotice() }
        }
        Text {
            objectName: "classicNote"
            visible: root.controller.fallback
            text: qsTr("Classic mode")
            color: Theme.approval
            font.pixelSize: Theme.fontSmall
            Accessible.description: qsTr("The Jarvis shell couldn't start, so this session is in classic mode.")
        }
        RowLayout {
            id: network
            objectName: "networkIndicator"
            spacing: 6
            readonly property bool known: root.shell !== null && root.shell.connection === "open" && root.shell.system.known
            readonly property string label: !known ? qsTr("Network unknown")
                                           : !root.shell.system.online ? qsTr("Offline")
                                           : root.shell.system.wifiSsid !== "" ? root.shell.system.wifiSsid
                                           : qsTr("Online")
            Accessible.name: qsTr("Network: %1").arg(label)
            Icon {
                path: network.known && root.shell.system.online ? Icons.wifi : Icons.offline
                color: Theme.textSoft
                size: 16
            }
            Text {
                objectName: "networkText"
                text: network.label
                textFormat: Text.PlainText
                color: Theme.textSoft
                font.pixelSize: Theme.fontSmall
            }
        }
        Text {
            objectName: "clock"
            Layout.leftMargin: 8
            Layout.rightMargin: 8
            text: UiLanguage.formatTime(root.now, UiLanguage.code)
            color: Theme.text
            font.pixelSize: Theme.fontSmall
        }
        TaskbarButton {
            objectName: "jarvisButton"
            text: qsTr("Jarvis")
            iconPath: Icons.logo
            active: root.controller.chatOpen
            Accessible.description: qsTr("Open the Jarvis chat")
            onClicked: root.controller.toggleChat()
        }
    }
}
