import QtQuick
import QtQuick.Controls.Basic

// A checkbox with a wrapping label (design: "Encrypt …", "Log in automatically").
CheckBox {
    id: control
    spacing: 12
    padding: 0
    opacity: enabled ? 1 : 0.45
    font.family: Theme.sans
    font.pixelSize: Theme.fontSize
    Accessible.name: text

    indicator: Rectangle {
        implicitWidth: 20
        implicitHeight: 20
        x: control.mirrored ? control.width - width - control.rightPadding : control.leftPadding
        y: control.topPadding + (control.availableHeight - height) / 2
        radius: 4
        color: control.checked ? Theme.accent : Theme.surface
        border.width: control.checked ? 0 : 1
        border.color: Theme.borderStrong
        Icon {
            anchors.centerIn: parent
            visible: control.checked
            path: Icons.check
            color: Theme.accentInk
            strokeWidth: 2.4
            size: 16
        }
        Rectangle {
            anchors.fill: parent
            anchors.margins: -4
            radius: 8
            color: "transparent"
            border.width: 2
            border.color: Theme.accent
            visible: control.visualFocus
        }
    }
    contentItem: Text {
        leftPadding: control.mirrored ? 0 : control.indicator.width + control.spacing
        rightPadding: control.mirrored ? control.indicator.width + control.spacing : 0
        horizontalAlignment: Text.AlignLeft
        text: control.text
        textFormat: Text.PlainText
        font: control.font
        color: Theme.text
        wrapMode: Text.Wrap
        verticalAlignment: Text.AlignVCenter
    }
}
