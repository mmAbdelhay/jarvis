import QtQuick
import QtQuick.Controls.Basic

// 48x48 icon-only button (nav rail, composer). `text` is the accessible name
// and tooltip; it is never drawn.
AbstractButton {
    id: control
    property string iconPath
    property bool selected: false
    property color fill: selected ? Theme.surfaceRaised : "transparent"
    property color ink: selected ? Theme.accent : Theme.muted

    implicitWidth: 48
    implicitHeight: 48
    Accessible.name: text
    Accessible.role: Accessible.Button
    ToolTip.visible: hovered && text.length > 0
    ToolTip.text: text
    ToolTip.delay: 600

    contentItem: Item {
        Icon {
            anchors.centerIn: parent
            path: control.iconPath
            color: control.ink
        }
    }
    background: Rectangle {
        radius: 12
        color: control.fill
        Rectangle {
            anchors.fill: parent
            anchors.margins: -3
            radius: 15
            color: "transparent"
            border.width: 2
            border.color: Theme.accent
            visible: control.visualFocus
        }
    }
}
