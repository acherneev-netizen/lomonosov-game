"""Check the deployable site using only the Python standard library."""
from pathlib import Path
from html.parser import HTMLParser
import base64, hashlib, json, re, shutil, subprocess, sys, tempfile

ROOT = Path(__file__).resolve().parents[1]
NOTICE_HASHES = {
    'COPYRIGHT.txt': '5e60eb378e9b91d10e0d0134b720e802b3f0312ae9f23aac710ae68a3587a7ec',
    'THIRD_PARTY_NOTICES.txt': '4d4071bb67196809b8aba1761787bc34bd8e9e6fffd3639ac17ce498815d610b',
}
SITE_FILES = ['index.html', 'docs/index.html', 'COPYRIGHT.txt', 'THIRD_PARTY_NOTICES.txt', '.nojekyll']
EXPECTED_MEDIA = '1bc258ab04ddc7275d94fa094602e860cf5b252213309c02daa304833ac1c7ec'

class Resources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []
    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if value and (key in ('src', 'poster', 'href') or tag == 'object' and key == 'data'):
                self.urls.append(value)

def verify():
    for name in SITE_FILES:
        assert (ROOT / name).is_file(), f'Missing: {name}'
    for name, expected in NOTICE_HASHES.items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == expected, f'Original notice modified: {name}'
    for name in ('index.html', 'docs/index.html'):
        html = (ROOT / name).read_text('utf-8')
        assert '<meta name="author" content="Чернеева Т. А.">' in html
        assert '© 2026. Автор — Чернеева Т. А. Все права защищены.' in html
        assert not re.search(r'file://|[A-Za-z]:\\|(?:src|href)=["\x27]/(?!/)', html)
        parser = Resources()
        parser.feed(html)
        for url in parser.urls:
            assert not url.startswith(('http:', 'https:', '//')), f'Unexpected external dependency: {url}'
            if not url.startswith(('data:', '#', 'mailto:')):
                resolved = ((ROOT / name).parent / url).resolve()
                assert resolved.is_relative_to(ROOT), f'Path escapes site: {url}'
                if resolved.is_dir():
                    resolved /= 'index.html'
                assert resolved.is_file(), f'Broken resource/link: {url}'
    html = (ROOT / 'index.html').read_text('utf-8')
    assert 'name="copyright"' in html and 'id="author-credit"' in html
    media = [(mime, base64.b64decode(encoded, validate=True)) for mime, encoded in re.findall(r'data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)', html)]
    assert len(media) == 119, f'Expected 119 original media assets, got {len(media)}'
    assert sum(mime == 'audio/mpeg' for mime, _ in media) == 116
    digest = hashlib.sha256(b''.join(hashlib.sha256(data).digest() for _, data in media)).hexdigest()
    assert digest == EXPECTED_MEDIA, f'Original media changed: {digest}'
    scripts = re.findall(r'<script\b([^>]*)>(.*?)</script>', html, re.S)
    for attrs, source in scripts:
        if 'application/json' in attrs:
            json.loads(source)
            continue
        with tempfile.TemporaryDirectory() as temp:
            script = Path(temp) / 'check.mjs'
            script.write_text(source, encoding='utf-8')
            subprocess.run(['node', '--check', str(script)], check=True)
    print(f'PASS: HTML, links, author, original notices, JavaScript syntax, {len(media)} unchanged media assets.')

if __name__ == '__main__':
    verify()
    if '--stage' in sys.argv:
        output = ROOT / '_site'
        # Delete only this known, local build directory; reject symlink targets.
        assert output.parent == ROOT and not output.is_symlink()
        if output.exists():
            shutil.rmtree(output)
        for name in SITE_FILES:
            destination = output / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        print('Staged only public website files in _site/')
