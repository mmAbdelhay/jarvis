import unittest
import urllib.error
import urllib.request

from jarvis_smoke import connectivity


class ConnectivityTest(unittest.TestCase):
    def setUp(self):
        self.server = connectivity.start(0)
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_answers_like_network_test_debian_org(self):
        with urllib.request.urlopen(f"{self.base}/nm") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["X-NetworkManager-Status"], "online")
            self.assertEqual(response.read(), b"NetworkManager is online\n")

    def test_other_paths_are_404(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f"{self.base}/other")
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
