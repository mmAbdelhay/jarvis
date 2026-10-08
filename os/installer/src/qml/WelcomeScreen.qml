import QtQuick
import QtQuick.Layouts
import Jarvis.UI

// Step 1 (design: Welcome). Detected language, keyboard and time zone. The
// "Prefer talking?" voice hint is M3 and not shown.
ColumnLayout {
    id: root
    required property InstallerModel installer

    // Injectable transport keeps explicit, opt-in detection testable offline.
    property var timezoneLookup: function(url, done) {
        const request = new XMLHttpRequest()
        request.onreadystatechange = function() {
            if (request.readyState === XMLHttpRequest.DONE) {
                if (request.status === 200) done(request.responseText)
                else root.timezoneStatus = "Could not detect your time zone. Choose it above."
                root.detectingTimezone = false
            }
        }
        request.open("GET", url)
        request.send()
    }
    property bool detectingTimezone: false
    property string timezoneStatus: ""

    spacing: 24

    ScreenTitle {
        Layout.fillWidth: true
        title: "Welcome"
        subtitle: "These were guessed from your locale and keyboard. Change anything that's wrong."
    }

    GridLayout {
        Layout.fillWidth: true
        columns: 3
        columnSpacing: 16
        rowSpacing: 16
        LabeledCombo {
            objectName: "language"
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            label: "Language"
            model: root.installer.locale.languages
            value: root.installer.locale.language
            onPicked: (v) => root.installer.locale.language = v
        }
        LabeledCombo {
            objectName: "keyboard"
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            label: "Keyboard"
            model: root.installer.locale.keyboards
            value: root.installer.locale.keyboard
            onPicked: (v) => root.installer.locale.keyboard = v
        }
        LabeledCombo {
            objectName: "timezone"
            Layout.fillWidth: true
            Layout.preferredWidth: 1
            label: "Time zone"
            model: root.installer.locale.timezones
            value: root.installer.locale.timezone
            onPicked: (v) => root.installer.locale.timezone = v
        }
    }

    Text {
        objectName: "timezonePrivacy"
        Layout.fillWidth: true
        text: "Detect my time zone contacts geoip.ubuntu.com and shares your IP address."
        textFormat: Text.PlainText
        color: Theme.muted
        wrapMode: Text.Wrap
    }
    ActionButton {
        objectName: "detectTimezone"
        text: "Detect my time zone"
        variant: "quiet"
        enabled: !root.detectingTimezone
        onClicked: {
            root.detectingTimezone = true
            root.timezoneStatus = ""
            root.timezoneLookup("https://geoip.ubuntu.com/lookup", function(response) {
                const match = /<TimeZone>\s*([^<]+)\s*<\/TimeZone>/.exec(response)
                if (match) root.installer.locale.timezone = match[1].trim()
                else root.timezoneStatus = "Could not detect your time zone. Choose it above."
                root.detectingTimezone = false
            })
        }
    }
    Text {
        Layout.fillWidth: true
        visible: text.length > 0
        text: root.timezoneStatus
        textFormat: Text.PlainText
        color: Theme.muted
        wrapMode: Text.Wrap
    }

    Card {
        objectName: "uefiNotice"
        Layout.fillWidth: true
        tone: "approval"
        visible: root.installer.step === 0 && root.installer.probed && root.installer.blockText.length > 0
        Text {
            objectName: "uefiText"
            Layout.fillWidth: true
            text: root.installer.blockText
            textFormat: Text.PlainText
            color: Theme.text
            wrapMode: Text.Wrap
        }
    }

    Card {
        objectName: "probeError"
        Layout.fillWidth: true
        tone: "approval"
        visible: !root.installer.probed && root.installer.errorText.length > 0
        Text {
            Layout.fillWidth: true
            text: root.installer.errorText
            textFormat: Text.PlainText
            color: Theme.text
            wrapMode: Text.Wrap
        }
        ActionButton {
            objectName: "retryProbe"
            visible: root.installer.canRetryProbe
            variant: "quiet"
            implicitHeight: 36
            text: "Try again"
            onClicked: root.installer.start()
        }
    }
}
