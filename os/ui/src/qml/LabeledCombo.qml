import QtQuick
import QtQuick.Layouts
import QtQuick.Controls.Basic

// A labelled drop-down (design: Welcome's Language / Keyboard / Time zone).
// model: [{value, text}]. `value` flows in; choices flow out through picked().
ColumnLayout {
    id: root
    property string label
    property var model: []
    property string value
    readonly property alias combo: box
    signal picked(string value)

    function syncValue() {
        box.currentIndex = box.indexOfValue(root.value)
    }
    onValueChanged: syncValue()
    Component.onCompleted: syncValue()

    spacing: 6
    Text {
        text: root.label
        textFormat: Text.PlainText
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }
    ComboBox {
        id: box
        Layout.fillWidth: true
        implicitHeight: Theme.controlHeight
        model: root.model
        textRole: "text"
        valueRole: "value"
        onModelChanged: root.syncValue()
        onCountChanged: root.syncValue()
        font.family: Theme.sans
        font.pixelSize: Theme.fontSize
        Accessible.name: root.label
        contentItem: Text {
            leftPadding: 12
            text: box.displayText
            textFormat: Text.PlainText
            font: box.font
            color: Theme.text
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }
        background: Rectangle {
            radius: Theme.radiusControl
            color: Theme.surface
            border.color: box.activeFocus ? Theme.accentTintBorder : Theme.borderStrong
        }
        onActivated: root.picked(currentValue)
    }
}
