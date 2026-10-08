import QtQuick
import QtQuick.Layouts

// "previous → current" for a setting change (Rafiq M3 design §2.1). Both
// values come from outside (tool descriptions/results): plain text only.
RowLayout {
    id: root
    property string from: ""
    property string to: ""
    property color fromColor: Theme.muted
    property color toColor: Theme.text
    property int pixelSize: Theme.fontSmall

    spacing: 8
    Accessible.role: Accessible.StaticText
    Accessible.name: "From " + from + " to " + to

    Text {
        objectName: "changeFrom"
        Layout.maximumWidth: 260
        text: root.from
        textFormat: Text.PlainText
        color: root.fromColor
        font.pixelSize: root.pixelSize
        elide: Text.ElideRight
    }
    Icon { path: Icons.arrowRight; color: root.fromColor; size: 14; strokeWidth: 2 }
    Text {
        objectName: "changeTo"
        Layout.maximumWidth: 260
        text: root.to
        textFormat: Text.PlainText
        color: root.toColor
        font.pixelSize: root.pixelSize
        font.weight: Font.DemiBold
        elide: Text.ElideRight
    }
}
