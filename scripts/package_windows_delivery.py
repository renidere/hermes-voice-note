"""Repackage the pinned, qualified client; never rebuild or modify its files."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile


EXE = 'hermes-light-3b42157.exe'
EXTRAS = {'HERMES-LICENSE.txt', 'VOICE-NOTE-LICENSE.txt', 'WINDOWS-CLIENT.ru.md', 'voice-note-plugin/plugin.js'}


def sha256(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def package_delivery(base_zip, output_zip, source_root, expected_base_sha256):
    base_zip, output_zip, source_root = map(Path, (base_zip, output_zip, source_root))
    if sha256(base_zip) != expected_base_sha256:
        raise ValueError('Base Windows package hash does not match the qualified release')
    if output_zip.exists():
        raise FileExistsError('Refusing to replace an existing delivery archive')
    replacements = {
        'Start-Voice-Note.cmd': (source_root / 'install/Start-Voice-Note.cmd').read_bytes(),
        'voice-note-delivery/Start-Voice-Note.ps1': (source_root / 'install/Start-Voice-Note.ps1').read_bytes(),
        'voice-note-plugin/plugin.js': (source_root / 'plugin.js').read_bytes(),
        'WINDOWS-CLIENT.ru.md': (source_root / 'WINDOWS-CLIENT.ru.md').read_bytes(),
    }
    with zipfile.ZipFile(base_zip) as base:
        infos = [entry for entry in base.infolist() if not entry.is_dir()]
        names = [entry.filename for entry in infos]
        segments = {}
        for name in names + list(replacements) + ['voice-note-delivery/manifest.json']:
            path = PurePosixPath(name)
            if path.is_absolute() or str(path) != name or any(part in {'.', '..'} for part in path.parts) or '\\' in name or ':' in name:
                raise ValueError('Unsafe Windows archive path')
            prefix = ()
            for part in path.parts:
                key = (*prefix, part.casefold())
                if key in segments and segments[key] != part:
                    raise ValueError('Case-colliding Windows archive path')
                segments[key] = part
                prefix = key
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive member')
        if not {EXE, 'resources/app.asar'} <= set(names):
            raise ValueError('Incomplete qualified Windows client')
        files = {entry.filename: hashlib.sha256(base.read(entry)).hexdigest() for entry in infos if entry.filename not in EXTRAS}
        files['voice-note-plugin/plugin.js'] = hashlib.sha256(replacements['voice-note-plugin/plugin.js']).hexdigest()
        manifest = {'schemaVersion': 1, 'pluginId': 'hermes-voice-note', 'executable': EXE, 'clientVersion': '0.4.1', 'basePackageSha256': expected_base_sha256, 'files': files}
        replacements['voice-note-delivery/manifest.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
        output_zip.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_zip, 'x', compression=zipfile.ZIP_DEFLATED) as output:
            for entry in infos:
                if entry.filename not in replacements:
                    output.writestr(entry, base.read(entry))
            for name, content in replacements.items():
                output.writestr(name, content)
    with zipfile.ZipFile(output_zip) as output:
        if output.testzip() is not None:
            raise ValueError('Delivery ZIP CRC verification failed')
        for name, expected in files.items():
            if hashlib.sha256(output.read(name)).hexdigest() != expected:
                raise ValueError('Delivery payload hash verification failed')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-zip', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    pin = json.loads((root / 'install/windows-delivery-base.json').read_text())
    result = package_delivery(args.base_zip, args.output, root, pin['sha256'])
    print(json.dumps({'packageSha256': sha256(args.output), 'verifiedFiles': len(result['files']), 'basePackageSha256': pin['sha256']}))
