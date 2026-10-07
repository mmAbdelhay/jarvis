import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

// A selectable tile (radio semantics): large with a detail line, or compact.
AbstractButton {
    id: control
    property string title
    property string detail
    property bool selected: false
    property bool compact: false

    implicitHeight: compact ? 44 : Math.max(96, content.implicitHeight + 32)
    padding: compact ? 0 : 16
    Accessible.role: Accessible.RadioButton
    Accessible.checked: selected
    Accessible.name: title

    contentItem: ColumnLayout {
        id: content
        spacing: 4
        Text {
            Layout.fillWidth: true
            horizontalAlignment: control.compact ? Text.AlignHCenter : Text.AlignLeft
            text: control.title
            textFormat: Text.PlainText
            color: Theme.text
            font.pixelSize: control.compact ? 14 : Theme.fontSize
            font.weight: control.compact ? Font.Normal : Font.DemiBold
        }
        Text {
            Layout.fillWidth: true
            visible: !control.compact && control.detail.length > 0
            text: control.detail
            color: Theme.muted
            font.pixelSize: Theme.fontSmall
            wrapMode: Text.Wrap
        }
    }
    background: Rectangle {
        radius: control.compact ? Theme.radiusControl : 12
        color: control.selected ? Theme.accentTint : Theme.surface
        border.width: control.selected ? 2 : 1
        border.color: control.selected ? Theme.accent : Theme.borderStrong
        Rectangle {
            anchors.fill: parent
            anchors.margins: -4
            radius: parent.radius + 4
            color: "transparent"
            border.width: 2
            border.color: Theme.accent
            visible: control.visualFocus
        }
    }
}
