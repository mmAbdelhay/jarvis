import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "VoiceUi"
    when: windowShown
    visible: true
    width: 900
    height: 600

    Component { id: composerComponent; Composer { width: 760 } }
    Component { id: sectionComponent; VoiceSection { width: 760 } }
    Component { id: spyComponent; SignalSpy {} }

    function cleanup() {
        testShell.voice.setAvailability(false, "", "")
        testShell.voice.applyServerState({ state: "idle" })
    }

    function test_micFollowsAvailability() {
        const c = createTemporaryObject(composerComponent, testCase, { voice: testShell.voice })
        const mic = findChild(c, "micButton")
        verify(!mic.visible)
        testShell.voice.setAvailability(true, "whisper base", "en_US-amy-medium")
        verify(mic.visible)
        const spy = createTemporaryObject(spyComponent, testCase, { target: c, signalName: "micRequested" })
        mouseClick(mic)
        compare(spy.count, 1)
    }

    function test_indicatorFollowsTheServer() {
        const c = createTemporaryObject(composerComponent, testCase, { voice: testShell.voice })
        testShell.voice.setAvailability(true, "whisper base", "en_US-amy-medium")
        const indicator = findChild(c, "voiceIndicator")
        verify(!indicator.visible)
        testShell.voice.applyServerState({ state: "speaking", lang: "en" })
        verify(indicator.visible)
        verify(findChild(c, "voiceState").text.indexOf("Speaking") >= 0)
        compare(findChild(c, "voiceState").textFormat, Text.PlainText)
    }

    function test_voiceSection() {
        testShell.voice.setAvailability(true, "whisper base", "en_US-amy-medium")
        const s = createTemporaryObject(sectionComponent, testCase, { voice: testShell.voice })
        verify(findChild(s, "voiceStatus").text.indexOf("whisper base") >= 0)
        const toggle = findChild(s, "speakReplies")
        const before = testShell.voice.speakReplies
        compare(toggle.checked, before)
        mouseClick(toggle)
        compare(testShell.voice.speakReplies, !before)
        testShell.voice.speakReplies = before
        testShell.voice.setAvailability(false, "", "")
        verify(findChild(s, "voiceStatus").text.indexOf("isn't installed") >= 0)
        verify(!toggle.enabled)
    }
}
