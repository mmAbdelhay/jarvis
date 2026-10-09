import QtQuick
import QtQuick.Controls.Basic

// A drop-down drawn entirely from Theme (Plan Y §4.2). Basic's own disabled
// look is a light grey box; here a disabled box is the deep surface with
// muted text, and the popup is the raised surface.
ComboBox {
    id: box
    readonly property color fieldColor: enabled ? Theme.surface : Theme.fieldDisabled
    readonly property color inkColor: enabled ? Theme.text : Theme.textDisabled

    implicitHeight: Theme.controlHeight
    opacity: 1
    font.family: Theme.sans
    font.pixelSize: Theme.fontSize

    contentItem: Text {
        leftPadding: box.mirrored ? box.indicator.width + 16 : 12
        rightPadding: box.mirrored ? 12 : box.indicator.width + 16
        text: box.displayText
        textFormat: Text.PlainText
        font: box.font
        color: box.inkColor
        verticalAlignment: Text.AlignVCenter
        horizontalAlignment: Text.AlignLeft
        elide: Text.ElideRight
    }

    indicator: Icon {
        x: box.mirrored ? 12 : box.width - width - 12
        y: (box.height - height) / 2
        path: "M6 9l6 6 6-6"
        color: box.inkColor
        size: 16
    }

    background: Rectangle {
        radius: Theme.radiusControl
        color: box.fieldColor
        border.color: box.activeFocus ? Theme.accentTintBorder : Theme.borderStrong
    }

    delegate: ItemDelegate {
        id: option
        required property int index
        width: ListView.view ? ListView.view.width : box.width
        highlighted: box.highlightedIndex === index
        contentItem: Text {
            text: box.textAt(option.index)
            textFormat: Text.PlainText
            font: box.font
            color: Theme.text
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
        }
        background: Rectangle {
            radius: 8
            color: option.highlighted ? Theme.accentTint : "transparent"
        }
    }

    popup: Popup {
        y: box.height + 4
        width: box.width
        padding: 4
        implicitHeight: Math.min(list.contentHeight + 8, 320)
        contentItem: ListView {
            id: list
            clip: true
            implicitHeight: contentHeight
            model: box.popup.visible ? box.delegateModel : null
            currentIndex: box.highlightedIndex
        }
        background: Rectangle {
            radius: Theme.radiusControl
            color: Theme.surfaceRaised
            border.color: Theme.borderStrong
        }
    }
}
