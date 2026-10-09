import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// The 32 px heading and muted line every installer screen starts with.
ColumnLayout {
    id: root
    property string title
    property string subtitle

    spacing: 8
    Text {
        objectName: "screenTitle"
        Layout.fillWidth: true
        text: root.title
        textFormat: Text.PlainText
        color: Theme.text
        font.pixelSize: Theme.fontTitle
        font.weight: Font.DemiBold
        wrapMode: Text.Wrap
        Accessible.role: Accessible.Heading
    }
    Text {
        objectName: "screenSubtitle"
        Layout.fillWidth: true
        visible: text.length > 0
        text: root.subtitle
        textFormat: Text.PlainText
        color: Theme.muted
        wrapMode: Text.Wrap
    }
}
