import QtQuick
import Jarvis.UI
import QtQuick.Layouts

// 72 px rail: chat, activity log, apps, settings; terminal pinned at the bottom.
Rectangle {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
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
            text: qsTr("Chat")
            iconPath: Icons.chat
            selected: root.current === "chat"
            onClicked: root.navigate("chat")
        }
        IconButton {
            objectName: "navAudit"
            Layout.alignment: Qt.AlignHCenter
            text: qsTr("Activity log")
            iconPath: Icons.activity
            selected: root.current === "audit"
            onClicked: root.navigate("audit")
        }
        IconButton {
            objectName: "navApps"
            Layout.alignment: Qt.AlignHCenter
            text: qsTr("Apps")
            iconPath: Icons.apps
            selected: root.current === "apps"
            onClicked: root.navigate("apps")
        }
        IconButton {
            objectName: "navSettings"
            Layout.alignment: Qt.AlignHCenter
            text: qsTr("Settings")
            iconPath: Icons.settings
            selected: root.current === "settings"
            onClicked: root.navigate("settings")
        }
        Item { Layout.fillHeight: true }
        IconButton {
            objectName: "navTerminal"
            Layout.alignment: Qt.AlignHCenter
            text: qsTr("Open terminal")
            iconPath: Icons.terminal
            onClicked: root.terminalRequested()
        }
    }
}
