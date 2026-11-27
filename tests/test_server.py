"""Run with: python -m unittest discover -s tests -v"""
import os
from pathlib import Path
import sys
import tempfile
import threading
import json
import urllib.request
import urllib.error
import unittest

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import scan_pairs, save_mask_atomic, digest, RevisionConflict, AppServer


class MaskEditorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.prefix = 'Field_2026__trial_07T1'
        self.rgb = self.root / f'{self.prefix}__IMAGE__preview.png'
        self.mask = self.root / f'{self.prefix}__MASK__object_01.png'
        Image.new('RGB', (8, 5), (10, 40, 80)).save(self.rgb)
        im = Image.new('RGBA', (8, 5), (0, 0, 0, 255))
        im.putpixel((1, 2), (127, 127, 127, 255))
        im.putpixel((6, 4), (255, 255, 255, 92))
        im.save(self.mask)

    def tearDown(self):
        self.tmp.cleanup()

    def test_pairing_uses_entire_prefix(self):
        entries, warnings, lookup = scan_pairs(self.root)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]['identifier'], self.prefix)
        self.assertEqual(entries[0]['image_name'], self.rgb.name)
        self.assertEqual(entries[0]['mask_name'], self.mask.name)
        self.assertEqual(len(warnings), 0)
        self.assertIn(entries[0]['id'], lookup)

    def test_multiple_masks_link_one_image(self):
        other = self.root / f'{self.prefix}__MASK__object_02.png'
        Image.new('L', (8, 5), 0).save(other)
        entries, warnings, _ = scan_pairs(self.root)
        self.assertEqual(len(entries), 2)
        self.assertEqual(len(warnings), 0)

    def test_ambiguous_image_rejected(self):
        Image.new('RGB', (8, 5)).save(self.root / f'{self.prefix}__IMAGE__other.png')
        entries, warnings, _ = scan_pairs(self.root)
        self.assertEqual(len(entries), 0)
        self.assertTrue(any('Несколько IMAGE' in s for s in warnings))

    def test_save_overwrites_same_filename_and_preserves_original_pixels(self):
        before = self.mask.read_bytes()
        original = Image.open(self.mask)
        grayscale = bytearray(original.getchannel('R').tobytes())
        grayscale[3 * 8 + 4] = 255
        changed, rev = save_mask_atomic(self.mask, bytes(grayscale), digest(before))
        self.assertTrue(changed)
        self.assertEqual(rev, digest(self.mask.read_bytes()))
        self.assertFalse(any(p.name.startswith('.wheatmask_') for p in self.root.iterdir()))
        result = Image.open(self.mask)
        self.assertEqual(result.mode, 'RGBA')
        self.assertEqual(result.size, (8, 5))
        for y in range(5):
            for x in range(8):
                self.assertEqual(result.getpixel((x, y)), ((255, 255, 255, 255) if (x, y) == (4, 3) else original.getpixel((x, y))))

    def test_conflict_does_not_overwrite(self):
        before = self.mask.read_bytes()
        Image.new('RGBA', (8, 5), (255, 255, 255, 255)).save(self.mask)
        after = self.mask.read_bytes()
        with self.assertRaises(RevisionConflict):
            save_mask_atomic(self.mask, bytes(8*5), digest(before))
        self.assertEqual(after, self.mask.read_bytes())

    def test_no_op_does_not_rewrite_png(self):
        before = self.mask.read_bytes()
        gray = Image.open(self.mask).getchannel('R').tobytes()
        changed, rev = save_mask_atomic(self.mask, gray, digest(before))
        self.assertFalse(changed)
        self.assertEqual(before, self.mask.read_bytes())
        self.assertEqual(rev, digest(before))

    def test_http_api_save_and_stale_revision(self):
        server = AppServer(('127.0.0.1', 0), self.root, 'test-token')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f'http://127.0.0.1:{server.server_address[1]}'
        def call(path, *, data=None, headers=None):
            return urllib.request.urlopen(urllib.request.Request(origin + path, data=data, headers={
                'X-Editor-Token': 'test-token', **(headers or {})}, method='POST' if data is not None else 'GET'))
        try:
            with call('/api/pairs') as response:
                pairs = json.load(response)['pairs']
            self.assertEqual(len(pairs), 1)
            pair_id = pairs[0]['id']
            with call(f'/api/pairs/{pair_id}/mask.raw') as response:
                raw = bytearray(response.read())
                revision = response.headers['X-Mask-Revision']
            self.assertEqual(len(raw), 40)
            raw[0] = 255
            with call(f'/api/pairs/{pair_id}/save', data=bytes(raw), headers={
                'If-Match': f'"{revision}"', 'Content-Type': 'application/octet-stream'}) as response:
                outcome = json.load(response)
            self.assertTrue(outcome['modified'])
            self.assertEqual(Image.open(self.mask).getpixel((0, 0))[:3], (255, 255, 255))
            with self.assertRaises(urllib.error.HTTPError) as error:
                call(f'/api/pairs/{pair_id}/save', data=bytes(raw), headers={
                    'If-Match': f'"{revision}"', 'Content-Type': 'application/octet-stream'})
            self.assertEqual(error.exception.code, 409)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_mismatch_skipped(self):
        Image.new('L', (4, 5)).save(self.mask)
        entries, warnings, _ = scan_pairs(self.root)
        self.assertEqual(len(entries), 0)
        self.assertTrue(any('Размеры не совпадают' in warning for warning in warnings))


if __name__ == '__main__':
    unittest.main()
