import QtQuick
import QtQuick.Layouts

// The greeter's big clock and date, shared with the lock screen.
ColumnLayout {
    id: root
    property date now: new Date()
    spacing: 4

    Timer {
        interval: 1000
        running: true
        repeat: true
        onTriggered: root.now = new Date()
    }
    Text {
        objectName: "clock"
        Layout.alignment: Qt.AlignHCenter
        text: Qt.formatTime(root.now, "HH:mm")
        color: Theme.text
        font.pixelSize: Math.round(96 * Theme.textScale)
        font.weight: Font.Light
        font.letterSpacing: -2
    }
    Text {
        objectName: "date"
        Layout.alignment: Qt.AlignHCenter
        text: Qt.formatDate(root.now, "dddd, d MMMM")
        color: Theme.muted
        font.pixelSize: Theme.fontSize
    }
}
