import QtQuick
import Jarvis.UI
import QtQuick.Layouts
import QtQuick.Controls.Basic

// The orange status strip: connection trouble or an unreachable provider,
// with the way out (spec §10: Network doctor, settings one tap away).
Rectangle {
    id: root
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true
    property string text
    property bool showDoctor: false   // ShellController.offerDoctor (contracts §6.8)
    property bool showSettings: false
    signal doctorRequested()
    signal settingsRequested()

    implicitHeight: row.implicitHeight + 20
    color: Theme.warnBannerBg
    Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 1; color: Theme.warnBannerBorder }

    RowLayout {
        id: row
        anchors.fill: parent
        anchors.leftMargin: 28
        anchors.rightMargin: 28
        spacing: 12
        Icon { path: Icons.offline; color: Theme.warn; strokeWidth: 2; size: 20 }
        Text {
            objectName: "bannerText"
            Layout.fillWidth: true
            text: root.text
            textFormat: Text.PlainText
            color: Theme.warnBannerText
            elide: Text.ElideRight
        }
        ActionButton {
            objectName: "bannerDoctor"
            visible: root.showDoctor
            variant: "ghost"
            implicitHeight: 36
            text: qsTr("Network doctor")
            onClicked: root.doctorRequested()
        }
        ActionButton {
            objectName: "bannerSettings"
            visible: root.showSettings
            variant: "ghost"
            implicitHeight: 36
            text: qsTr("Settings")
            onClicked: root.settingsRequested()
        }
    }
}
