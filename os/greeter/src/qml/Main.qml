import QtQuick
import Jarvis.UI

// cage shows exactly one full-screen window: this one.
Window {
    id: window
    required property LoginModel login
    required property ModelStatus modelStatus
    required property string keyboardCode
    required property string keyboardName

    title: Brand.distroName
    width: 1440
    height: 900
    color: Theme.surfaceDeep
    visible: false

    LoginScreen {
        anchors.fill: parent
        login: window.login
        modelStatus: window.modelStatus
        keyboardCode: window.keyboardCode
        keyboardName: window.keyboardName
    }
}
