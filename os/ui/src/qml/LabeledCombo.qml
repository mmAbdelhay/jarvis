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
    ThemedCombo {
        id: box
        Layout.fillWidth: true
        model: root.model
        textRole: "text"
        valueRole: "value"
        onModelChanged: root.syncValue()
        onCountChanged: root.syncValue()
        Accessible.name: root.label
        onActivated: root.picked(currentValue)
    }
}
