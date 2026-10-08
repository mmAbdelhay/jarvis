import QtQuick
import QtQuick.Layouts

// A rounded panel (design: "While you wait", Review notice, failure box).
// tone: "plain" (surface), "approval" (amber, for disk warnings), "accent" (teal).
Rectangle {
    id: root
    default property alias content: column.data
    property string tone: "plain"
    property int padding: 18

    implicitWidth: column.implicitWidth + 2 * padding
    implicitHeight: column.implicitHeight + 2 * padding
    radius: 12
    color: tone === "approval" ? Theme.approvalCard : tone === "accent" ? Theme.accentTint : Theme.surface
    border.color: tone === "approval" ? Theme.approval : tone === "accent" ? Theme.accentTintBorder : Theme.border

    ColumnLayout {
        id: column
        anchors.fill: parent
        anchors.margins: root.padding
        spacing: 6
    }
}
