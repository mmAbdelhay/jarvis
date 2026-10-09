import QtQuick
import QtQuick.Controls.Basic
import Jarvis.UI

// One taskbar button: icon and label, tinted while its panel is open.
AbstractButton {
    id: control
    property string iconPath
    property bool active: false

    implicitHeight: 40
    implicitWidth: row.implicitWidth + 24
    Accessible.role: Accessible.Button
    Accessible.name: text

    contentItem: Item {
        Row {
            id: row
            anchors.centerIn: parent
            spacing: 8
            Icon {
                anchors.verticalCenter: parent.verticalCenter
                path: control.iconPath
                color: control.active ? Theme.accent : Theme.textSoft
                size: 18
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: control.text
                color: Theme.text
                font.pixelSize: Theme.fontSmall
            }
        }
    }
    background: Rectangle {
        radius: Theme.radiusControl
        color: control.active ? Theme.accentTint : control.hovered ? Theme.surfaceRaised : "transparent"
        border.color: control.visualFocus ? Theme.accent : "transparent"
    }
}
