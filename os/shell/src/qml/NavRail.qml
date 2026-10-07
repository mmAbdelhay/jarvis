import QtQuick
import QtQuick.Layouts

// 72 px rail: chat, activity log, settings; terminal pinned at the bottom.
Rectangle {
    id: root
    property string current
    signal navigate(string view)
    signal terminalRequested()

    implicitWidth: 72
    color: Theme.surfaceDeep
    Rectangle { anchors.right: parent.right; width: 1; height: parent.height; color: Theme.border }

    ColumnLayout {
        anchors.fill: parent
        anchors.topMargin: 16
        anchors.bottomMargin: 16
        spacing: 8
        IconButton {
            objectName: "navChat"
            Layout.alignment: Qt.AlignHCenter
            text: "Chat"
            iconPath: Icons.chat
            selected: root.current === "chat"
            onClicked: root.navigate("chat")
        }
        IconButton {
            objectName: "navAudit"
            Layout.alignment: Qt.AlignHCenter
            text: "Activity log"
            iconPath: Icons.activity
            selected: root.current === "audit"
            onClicked: root.navigate("audit")
        }
        IconButton {
            objectName: "navSettings"
            Layout.alignment: Qt.AlignHCenter
            text: "Settings"
            iconPath: Icons.settings
            selected: root.current === "settings"
            onClicked: root.navigate("settings")
        }
        Item { Layout.fillHeight: true }
        IconButton {
            objectName: "navTerminal"
            Layout.alignment: Qt.AlignHCenter
            text: "Open terminal"
            iconPath: Icons.terminal
            onClicked: root.terminalRequested()
        }
    }
}
