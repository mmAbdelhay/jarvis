import json
import unittest
from pathlib import Path

import updates

SCRIPT = Path(__file__).resolve().parents[1] / "assets" / "scripts" / "update-computer.json"


class UpdatesTest(unittest.TestCase):
    def test_fake_provider_script(self):
        turns = json.loads(SCRIPT.read_text())
        self.assertEqual(len(turns), 1)
        replies = turns[0]["replies"]
        self.assertEqual(turns[0]["expectPromptContains"], "update my computer")
        self.assertEqual(replies[0]["toolCalls"][0]["name"], "updates.list")
        apply = replies[1]["toolCalls"][0]
        self.assertEqual(apply["name"], "updates.apply")
        self.assertEqual(apply["input"], {"items": [{"source": "apt", "id": "jarvis-shell"}]})
        self.assertIn("text", replies[2])

    def test_sources_keep_the_package_keyring(self):
        self.assertIn("Signed-By: /usr/share/keyrings/jarvis-archive-keyring.gpg", updates.rogue_source())
        self.assertIn("http://10.0.2.2:8098/rogue", updates.rogue_source())
        self.assertIn("s#^URIs: .*#URIs: http://10.0.2.2:8098/good#", updates.point_at_good())
        # The shipped source is "Enabled: no" until the repo is published.
        self.assertIn("s/^Enabled: .*/Enabled: yes/", updates.point_at_good())

    def test_one_card_with_the_update(self):
        lines = [
            '{"type":"turn-start","turnId":"t","text":"update my computer"}',
            '{"type":"card","card":{"cardId":"c1","items":[{"itemId":"i1","title":"Upgrade jarvis-shell"}]}}',
            '{"type":"card-closed","cardId":"c1","decision":"approved"}',
        ]
        self.assertEqual(updates.cards("\n".join(lines))[0]["cardId"], "c1")
        self.assertEqual(len(updates.cards("\n".join(lines))), 1)
