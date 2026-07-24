import unittest

from calc import total


class TestTotal(unittest.TestCase):
    def test_total(self):
        self.assertEqual(total([1, 2, 3]), 6)


if __name__ == "__main__":
    unittest.main()
