import QtQuick
import QtTest
import Jarvis.UI
import Jarvis.Shell

TestCase {
    id: testCase
    name: "MemorySection"
    when: windowShown
    visible: true
    width: 900
    height: 700

    Component { id: memoryComponent; MemoryModel {} }
    Component { id: sectionComponent; MemorySection { width: 860 } }
    Component { id: spyComponent; SignalSpy {} }

    function makeSection(items) {
        const memory = createTemporaryObject(memoryComponent, testCase)
        memory.applyItems(items)
        const section = createTemporaryObject(sectionComponent, testCase, { memory: memory })
        waitForRendering(section)
        return { memory: memory, section: section }
    }

    readonly property var twoItems: [
        { id: "m2", kind: "fact", text: "prefers <b>Flatpak</b>", createdAt: 1759900000000 },
        { id: "m1", kind: "summary", text: "Installed GIMP and VLC.", createdAt: 1759800000000 }
    ]

    function test_showsItemsAsPlainText() {
        const c = makeSection(twoItems)
        const text = findChild(c.section, "memoryText_m2")
        compare(text.text, "prefers <b>Flatpak</b>")
        compare(text.textFormat, Text.PlainText)
        verify(findChild(c.section, "memory_m1").visible)
        verify(!findChild(c.section, "memoryEmpty").visible)
    }

    function test_forgetOneSendsItsId() {
        const c = makeSection(twoItems)
        const deletes = createTemporaryObject(spyComponent, testCase, { target: c.memory, signalName: "deleteRequested" })
        mouseClick(findChild(c.section, "forget_m1"))
        compare(deletes.count, 1)
        compare(deletes.signalArguments[0][0], "m1")
    }

    function test_forgetEverythingNeedsAConfirm() {
        const c = makeSection(twoItems)
        const clears = createTemporaryObject(spyComponent, testCase, { target: c.memory, signalName: "clearRequested" })
        mouseClick(findChild(c.section, "forgetAll"))
        waitForRendering(c.section)
        compare(clears.count, 0)
        verify(findChild(c.section, "confirmForgetAll").visible)
        mouseClick(findChild(c.section, "cancelForgetAll"))
        waitForRendering(c.section)
        verify(!findChild(c.section, "confirmForgetAll").visible)
        mouseClick(findChild(c.section, "forgetAll"))
        waitForRendering(c.section)
        mouseClick(findChild(c.section, "confirmForgetAll"))
        compare(clears.count, 1)
    }

    function test_emptyAndError() {
        const c = makeSection([])
        verify(findChild(c.section, "memoryEmpty").visible)
        verify(!findChild(c.section, "forgetAll").visible)
        c.memory.applyError("Memory is off: the keyring is locked.")
        const error = findChild(c.section, "memoryError")
        verify(error.visible)
        compare(error.textFormat, Text.PlainText)
        verify(!findChild(c.section, "memoryEmpty").visible)
    }
}
