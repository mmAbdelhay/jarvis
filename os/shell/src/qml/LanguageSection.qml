import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Settings → Language (Rafiq M4 contracts §3). Applied at once through
// ui:setLanguage; every Rafiq window follows jarvisd's ui:language push.
ColumnLayout {
    id: root
    required property ShellController shell
    spacing: 14
    LayoutMirroring.enabled: Qt.application.layoutDirection === Qt.RightToLeft
    LayoutMirroring.childrenInherit: true

    Text {
        Layout.fillWidth: true
        text: qsTr("Jarvis and every %1 screen switch at once. Earlier messages stay in the language they were written in.").arg(Brand.distroName)
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: Theme.muted
        font.pixelSize: Theme.fontSmall
    }

    RowLayout {
        Layout.fillWidth: true
        spacing: 12
        Repeater {
            // Each language names itself, in its own script: never translated.
            model: [{ code: "en", name: "English" }, { code: "ar", name: "العربية" }] // i18n: ignore
            delegate: ChoiceTile {
                required property var modelData
                objectName: "language_" + modelData.code
                Layout.preferredWidth: 220
                compact: true
                title: modelData.name
                selected: root.shell.language === modelData.code
                enabled: !root.shell.languageBusy
                onClicked: root.shell.chooseLanguage(modelData.code)
            }
        }
    }

    Text {
        objectName: "languageNote"
        Layout.fillWidth: true
        visible: text.length > 0 || root.shell.languageBusy
        text: root.shell.languageBusy ? qsTr("Switching…") : root.shell.languageNote
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: root.shell.languageBusy ? Theme.muted : Theme.warn
        font.pixelSize: Theme.fontSmall
    }
}
