"""Tests for the disk guard + authed v51 log route. Run from v5.1/ourWebSocket/: python3 -m unittest test_server -v"""
import os, tempfile, unittest
import server, config as C


class DiskGuardTest(unittest.TestCase):
    def test_allows_write_under_caps(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(server._disk_guard(d, max_bytes=10**9, max_files=100))

    def test_blocks_when_too_many_files(self):
        with tempfile.TemporaryDirectory() as d:
            for i in range(5):
                open(os.path.join(d, f"f{i}.json"), "w").write("{}")
            self.assertFalse(server._disk_guard(d, max_bytes=10**9, max_files=5))

    def test_blocks_when_over_byte_budget(self):
        with tempfile.TemporaryDirectory() as d:
            open(os.path.join(d, "big.json"), "w").write("x" * 2000)
            self.assertFalse(server._disk_guard(d, max_bytes=1000, max_files=100))

    def test_missing_dir_allows(self):
        self.assertTrue(server._disk_guard("/no/such/dir", max_bytes=10**9, max_files=100))

    def test_secret_check(self):
        self.assertTrue(server._secret_ok("s3cr3t", "s3cr3t"))
        self.assertFalse(server._secret_ok("wrong", "s3cr3t"))
        self.assertFalse(server._secret_ok(None, "s3cr3t"))
        self.assertTrue(server._secret_ok("anything", ""))   # empty secret = open (dev)


if __name__ == "__main__":
    unittest.main()
