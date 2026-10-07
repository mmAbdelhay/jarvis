import QtQuick
import QtQuick.Layouts

// 44 px top bar: logo, active model pill, reachability, clock.
Rectangle {
    id: root
    required property ShellController shell

    implicitHeight: 44
    color: Theme.surfaceDeep
    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.border }

    RowLayout {
        anchors.fill: parent
        anchors.leftMargin: 20
        anchors.rightMargin: 20
        spacing: 10

        Icon { path: Icons.logo; color: Theme.accent; size: 22 }
        Text { text: "Jarvis"; color: Theme.text; font.weight: Font.DemiBold; font.letterSpacing: 0.6 }
        Item { Layout.fillWidth: true }

        Rectangle {
            objectName: "modelPill"
            visible: root.shell.provider.hasActive
            implicitHeight: 26
            implicitWidth: pill.implicitWidth + 22
            radius: 13
            color: "transparent"
            border.color: Theme.borderStrong
            RowLayout {
                id: pill
                anchors.centerIn: parent
                spacing: 8
                Rectangle {
                    implicitWidth: 7
                    implicitHeight: 7
                    radius: 3.5
                    color: root.shell.providerReachable ? Theme.accent : Theme.warn
                }
                Text {
                    text: root.shell.provider.activeModel + " · " + root.shell.provider.activeLabel
                    textFormat: Text.PlainText
                    color: Theme.muted
                    font.pixelSize: Theme.fontSmall
                }
            }
        }

        RowLayout {
            objectName: "reachBadge"
            readonly property bool offline: root.shell.system.known && !root.shell.system.online
            visible: offline || !root.shell.providerReachable
            spacing: 6
            Icon { path: Icons.offline; color: Theme.warn; strokeWidth: 2; size: 16 }
            Text {
                objectName: "reachText"
                text: parent.offline ? "Offline" : "Model unreachable"
                color: Theme.warn
                font.pixelSize: Theme.fontSmall
            }
        }

        Text {
            id: clock
            color: Theme.textSoft
            font.family: Theme.mono
            font.pixelSize: Theme.fontSmall
            text: Qt.formatTime(new Date(), "HH:mm")
            Timer {
                interval: 15000
                running: true
                repeat: true
                onTriggered: clock.text = Qt.formatTime(new Date(), "HH:mm")
            }
        }
    }
}
