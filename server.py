#!/usr/bin/env python3
"""Wheat Mask Editor: a small LAN-only HTTP server with exact grayscale-mask editing.

Python 3.10+ and Pillow are the only runtime requirements.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

from PIL import Image, ImageChops, UnidentifiedImageError

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
MAX_PIXELS = 45_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def image_size(path: Path) -> tuple[int, int]:
    with Image.open(path) as im:
        return im.size


def scan_pairs(root: Path) -> tuple[list[dict], list[str], dict[str, dict]]:
    """Pair files by ALL text before __IMAGE__ and __MASK__ in the same directory."""
    buckets: dict[tuple[str, str], dict[str, list[Path]]] = {}
    notes: list[str] = []
    for directory, subdirs, files in os.walk(root):
        subdirs[:] = sorted(d for d in subdirs if not d.startswith('.') and d != '__pycache__')
        for filename in sorted(files):
            if not filename.lower().endswith('.png'):
                continue
            markers = [marker for marker in ('__IMAGE__', '__MASK__') if marker in filename]
            if len(markers) != 1:
                continue
            # Avoid following file symlinks outside the selected dataset.
            if (Path(directory) / filename).is_symlink():
                continue
            marker = markers[0]
            prefix = filename.split(marker, 1)[0]
            if not prefix:
                notes.append(f'Пропущен файл без идентификатора: {filename}')
                continue
            rel_dir = str(Path(directory).relative_to(root))
            bucket = buckets.setdefault((rel_dir, prefix), {'__IMAGE__': [], '__MASK__': []})
            bucket[marker].append(Path(directory) / filename)

    entries = []
    for (directory, prefix), parts in sorted(buckets.items(), key=lambda x: (x[0][0].casefold(), x[0][1].casefold())):
        images, masks = parts['__IMAGE__'], parts['__MASK__']
        if not masks:
            notes.append(f'Нет MASK для: {directory}/{prefix}')
            continue
        if not images:
            notes.append(f'Нет IMAGE для: {directory}/{prefix} ({len(masks)} масок)')
            continue
        if len(images) != 1:
            notes.append(f'Несколько IMAGE с одним идентификатором: {directory}/{prefix}; пара пропущена')
            continue
        rgb_path = images[0]
        try:
            rgb_size = image_size(rgb_path)
        except (OSError, ValueError, UnidentifiedImageError) as exc:
            notes.append(f'Невозможно открыть IMAGE {rgb_path.name}: {exc}')
            continue
        for mask_path in masks:
            try:
                mask_size = image_size(mask_path)
            except (OSError, ValueError, UnidentifiedImageError) as exc:
                notes.append(f'Невозможно открыть MASK {mask_path.name}: {exc}')
                continue
            if rgb_size != mask_size:
                notes.append(f'Размеры не совпадают: {rgb_path.name} / {mask_path.name} ({rgb_size} / {mask_size})')
                continue
            if mask_size[0] * mask_size[1] > MAX_PIXELS:
                notes.append(f'Слишком большой MASK: {mask_path.name}')
                continue
            relative_mask = mask_path.relative_to(root).as_posix()
            relative_rgb = rgb_path.relative_to(root).as_posix()
            pair_id = digest(relative_mask.encode('utf-8'))[:20]
            entries.append({
                'id': pair_id,
                'identifier': prefix,
                'image_name': rgb_path.name,
                'mask_name': mask_path.name,
                'image_path': relative_rgb,
                'mask_path': relative_mask,
                'width': mask_size[0],
                'height': mask_size[1],
                '_image': rgb_path,
                '_mask': mask_path,
            })
    entries.sort(key=lambda item: (item['identifier'].casefold(), item['mask_path'].casefold()))
    return entries, notes, {item['id']: item for item in entries}


def grayscale_from_mask(im: Image.Image) -> bytes:
    """Return exact 8-bit grayscale values; reject colored masks rather than corrupt them."""
    if im.mode in ('L', 'LA'):
        return im.getchannel('L').tobytes()
    if im.mode in ('RGB', 'RGBA'):
        r, g, b = im.getchannel('R'), im.getchannel('G'), im.getchannel('B')
        if ImageChops.difference(r, g).getbbox() or ImageChops.difference(r, b).getbbox():
            raise ValueError('MASK содержит цветные пиксели (R≠G≠B); ожидается маска в оттенках серого')
        return r.tobytes()
    raise ValueError(f'Режим PNG {im.mode} не поддерживается; используйте L, LA, RGB или RGBA')


def updated_mask(im: Image.Image, new_values: bytes) -> tuple[Image.Image, bool]:
    """Keep original image mode and any alpha, changing only grayscale color values."""
    original = grayscale_from_mask(im)
    if original == new_values:
        return im, False
    gray = Image.frombytes('L', im.size, new_values)
    if im.mode == 'L':
        return gray, True
    if im.mode == 'LA':
        return Image.merge('LA', (gray, im.getchannel('A'))), True
    if im.mode == 'RGB':
        return Image.merge('RGB', (gray, gray, gray)), True
    if im.mode == 'RGBA':
        return Image.merge('RGBA', (gray, gray, gray, im.getchannel('A'))), True
    raise AssertionError('checked mode')


def save_mask_atomic(path: Path, new_values: bytes, expected_revision: str) -> tuple[bool, str]:
    original_bytes = path.read_bytes()
    if digest(original_bytes) != expected_revision:
        raise RevisionConflict('MASK изменился на диске после загрузки. Сохранение остановлено.')
    with Image.open(io.BytesIO(original_bytes)) as original_image:
        original_image.load()
        expected_length = original_image.width * original_image.height
        if len(new_values) != expected_length:
            raise ValueError(f'Ожидалось {expected_length} байт, получено {len(new_values)}')
        result, modified = updated_mask(original_image, new_values)
        if not modified:
            return False, expected_revision
        temporary: Path | None = None
        try:
            # Do not alter the original mask until a complete PNG is on disk.
            options = {}
            if 'icc_profile' in original_image.info:
                options['icc_profile'] = original_image.info['icc_profile']
            # IMPORTANT (Windows): fsync() must receive a WRITABLE descriptor.
            # The previous version reopened the PNG in 'rb' and called fsync()
            # on that read-only descriptor, causing OSError: [Errno 9].
            with tempfile.NamedTemporaryFile(
                mode='w+b', dir=path.parent, prefix='.wheatmask_',
                suffix='.png', delete=False,
            ) as output:
                temporary = Path(output.name)
                result.save(output, format='PNG', **options)
                output.flush()
                os.fsync(output.fileno())
            # The handle is closed here, allowing os.replace on Windows.
            # Recheck right before replacing (reject competing edits).
            if digest(path.read_bytes()) != expected_revision:
                raise RevisionConflict('MASK изменился во время сохранения. Попробуйте перечитать файл.')
            new_revision = digest(temporary.read_bytes())
            os.replace(temporary, path)
            return True, new_revision
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()


class RevisionConflict(Exception):
    pass


def safe_public(item: dict) -> dict:
    return {k: v for k, v in item.items() if not k.startswith('_')}


def discover_ipv4() -> list[str]:
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('1.1.1.1', 80))  # UDP route lookup only: no packet is sent.
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for record in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(record[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith('127.') and not ip.startswith('169.254.'))


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, root: Path, token: str):
        super().__init__(address, RequestHandler)
        self.root = root
        self.token = token
        self.lock = threading.RLock()
        self.entries, self.notes, self.by_id = scan_pairs(root)


class RequestHandler(BaseHTTPRequestHandler):
    server: AppServer
    protocol_version = 'HTTP/1.1'

    def log_message(self, format, *args):
        # Do not print URLs with the access token into logs.
        cleaned = tuple(str(x).replace(self.server.token, '[token]') for x in args)
        super().log_message(format, *cleaned)

    def send_data(self, code: int, content: bytes, kind: str, *, headers=None):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'DENY')
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(content)

    def json_data(self, code: int, data):
        self.send_data(code, json.dumps(data, ensure_ascii=False).encode('utf8'), 'application/json; charset=utf-8')

    def problem(self, code: int, msg: str):
        self.json_data(code, {'error': msg})

    def authorized(self, query):
        header = self.headers.get('X-Editor-Token', '')
        query_token = query.get('token', [''])[0]
        return secrets.compare_digest(header, self.server.token) or secrets.compare_digest(query_token, self.server.token)

    def do_GET(self):
        parsed = urlsplit(self.path)
        path, query = unquote(parsed.path), parse_qs(parsed.query)
        if path == '/':
            path = '/index.html'
        if path in ('/index.html', '/app.js', '/style.css'):
            file_path = WEB / path.lstrip('/')
            if file_path.exists():
                body = file_path.read_bytes()
                ctype = mimetypes.guess_type(file_path.name)[0] or 'application/octet-stream'
                if ctype.startswith('text/') or ctype.endswith('javascript'):
                    ctype += '; charset=utf-8'
                return self.send_data(200, body, ctype)
        if not path.startswith('/api/'):
            return self.problem(404, 'Ресурс не найден')
        if not self.authorized(query):
            return self.problem(401, 'Нет доступа: откройте ссылку с токеном из окна сервера')
        if path == '/api/pairs':
            if query.get('refresh') == ['1']:
                with self.server.lock:
                    self.server.entries, self.server.notes, self.server.by_id = scan_pairs(self.server.root)
            return self.json_data(200, {
                'pairs': [safe_public(e) for e in self.server.entries],
                'warnings': self.server.notes[:100],
                'warning_count': len(self.server.notes),
            })
        parts = path.split('/')
        if len(parts) == 5 and parts[:3] == ['', 'api', 'pairs']:
            pair_id, resource = parts[3], parts[4]
            pair = self.server.by_id.get(pair_id)
            if not pair:
                return self.problem(404, 'Пара не найдена. Обновите список.')
            if resource == 'image':
                return self.send_file(pair['_image'])
            if resource == 'mask':
                return self.send_file(pair['_mask'])
            if resource == 'mask.raw':
                try:
                    png_bytes = pair['_mask'].read_bytes()
                    with Image.open(io.BytesIO(png_bytes)) as im:
                        gray = grayscale_from_mask(im)
                        return self.send_data(200, gray, 'application/octet-stream', headers={
                            'X-Mask-Revision': digest(png_bytes),
                            'X-Image-Width': str(im.width),
                            'X-Image-Height': str(im.height),
                        })
                except (OSError, ValueError, UnidentifiedImageError) as exc:
                    return self.problem(422, str(exc))
        return self.problem(404, 'Ресурс не найден')

    def send_file(self, path: Path):
        try:
            data = path.read_bytes()
        except OSError as exc:
            return self.problem(500, f'Ошибка чтения: {exc}')
        return self.send_data(200, data, 'image/png')

    def do_POST(self):
        parsed = urlsplit(self.path)
        path, query = unquote(parsed.path), parse_qs(parsed.query)
        if not self.authorized(query):
            return self.problem(401, 'Нет доступа')
        parts = path.split('/')
        if not (len(parts) == 5 and parts[:3] == ['', 'api', 'pairs'] and parts[4] == 'save'):
            return self.problem(404, 'Ресурс не найден')
        pair = self.server.by_id.get(parts[3])
        if not pair:
            return self.problem(404, 'Пара не найдена')
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/octet-stream':
            return self.problem(415, 'Ожидается application/octet-stream')
        revision = self.headers.get('If-Match', '').strip().strip('"')
        if not revision or len(revision) != 64:
            return self.problem(428, 'Отсутствует версия исходной маски (If-Match)')
        expected_bytes = pair['width'] * pair['height']
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            length = -1
        if length != expected_bytes:
            return self.problem(400, f'Некорректная длина маски: ожидалось {expected_bytes} байт, получено {length}')
        data = self.rfile.read(length)
        if len(data) != length:
            return self.problem(400, 'Файл передан не полностью')
        try:
            with self.server.lock:
                modified, new_revision = save_mask_atomic(pair['_mask'], data, revision)
            return self.json_data(200, {'saved': True, 'modified': modified, 'revision': new_revision})
        except RevisionConflict as exc:
            return self.problem(409, str(exc))
        except (OSError, ValueError, UnidentifiedImageError) as exc:
            return self.problem(422, str(exc))


def main():
    parser = argparse.ArgumentParser(description='Wheat Mask Editor — server for iPad Safari')
    parser.add_argument('--data', type=Path, default=HERE / 'sample_data', help='Папка с RGB и MASK PNG')
    parser.add_argument('--host', default='0.0.0.0', help='Адрес сервера, 0.0.0.0 для локальной сети')
    parser.add_argument('--port', type=int, default=8765, help='Порт сервера')
    parser.add_argument('--token', default='', help='Необязательный фиксированный токен для тестов')
    args = parser.parse_args()
    root = args.data.expanduser().resolve()
    if not root.is_dir():
        parser.error(f'Папка не найдена: {root}')
    token = args.token or secrets.token_urlsafe(18)
    try:
        srv = AppServer((args.host, args.port), root, token)
    except OSError as exc:
        parser.error(f'Не удалось запустить сервер: {exc}')
    port = srv.server_address[1]
    print('\n' + '=' * 68, flush=True)
    print('           WHEAT MASK EDITOR — сервер запущен', flush=True)
    print(f'Папка: {root}', flush=True)
    print(f'Найдено пар: {len(srv.entries)}; предупреждений: {len(srv.notes)}', flush=True)
    print(f'На этом компьютере: http://127.0.0.1:{port}/?token={token}', flush=True)
    ips = discover_ipv4()
    for ip in ips:
        print(f'На iPad (Safari):   http://{ip}:{port}/?token={token}', flush=True)
    if not ips:
        print('IP компьютера: смотрите ipconfig (Windows) или Сеть (macOS).', flush=True)
    print('iPad и компьютер должны видеть друг друга в сети Wi-Fi.', flush=True)
    print('ДОСТУП: ссылка с токеном даёт право ПЕРЕЗАПИСЫВАТЬ маски.', flush=True)
    print('Не открывайте порт 8765 в интернет. Завершение: Ctrl+C.', flush=True)
    print('=' * 68 + '\n', flush=True)
    try:
        srv.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print('\nСервер остановлен.')
    finally:
        srv.server_close()


if __name__ == '__main__':
    main()
