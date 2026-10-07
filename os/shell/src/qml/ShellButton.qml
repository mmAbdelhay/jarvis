import QtQuick
import QtQuick.Controls.Basic

// Text button in the design's four looks: "primary" (teal), "approve" (amber),
// "ghost" (outlined, dark surfaces) and "quiet" (outlined, on approval cards).
// Keyboard focus shows the 2 px teal ring with a 2 px offset (the Deny button
// in the artboards).
Button {
    id: control
    property string variant: "ghost"

    implicitHeight: Theme.controlHeight
    leftPadding: 22
    rightPadding: 22
    opacity: enabled ? 1 : 0.4
    font.family: Theme.sans
    font.pixelSize: Theme.fontSize
    font.weight: variant === "primary" || variant === "approve" ? Font.DemiBold : Font.Medium

    contentItem: Text {
        text: control.text
        font: control.font
        textFormat: Text.PlainText
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        color: control.variant === "primary" ? Theme.accentInk
             : control.variant === "approve" ? Theme.approvalInk
             : Theme.text
    }

    background: Rectangle {
        radius: Theme.radiusControl
        color: control.variant === "primary" ? Theme.accent
             : control.variant === "approve" ? Theme.approval
             : "transparent"
        border.width: control.variant === "ghost" || control.variant === "quiet" ? 1 : 0
        border.color: control.variant === "quiet" ? Theme.approvalButtonBorder : Theme.borderStrong

        Rectangle {
            anchors.fill: parent
            anchors.margins: -4
            radius: parent.radius + 4
            color: "transparent"
            border.width: 2
            border.color: Theme.accent
            visible: control.activeFocus
        }
    }
}
