import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / 'scripts/package_windows_delivery.py'


class WindowsPackageTest(unittest.TestCase):
    def test_delivery_preserves_client_and_installs_from_one_explicit_entrypoint(self):
        self.assertTrue(BUILDER.is_file(), 'The Windows package needs an automatic, verified installation entrypoint')
        spec = importlib.util.spec_from_file_location('windows_delivery_builder', BUILDER)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='voice-package-', dir=ROOT.parent) as directory:
            root = Path(directory)
            source = root / 'source'
            (source / 'install').mkdir(parents=True)
            payload = {
                'install/Start-Voice-Note.cmd': b'@echo off\r\nrem synthetic launcher fixture\r\n',
                'install/Start-Voice-Note.ps1': b'# synthetic installer fixture\n',
                'plugin.js': b'export default {id:"hermes-voice-note"};\n',
                'WINDOWS-CLIENT.ru.md': 'Fixture: explicit launcher, no old protocol handler.\n'.encode(),
            }
            for name, content in payload.items():
                (source / name).write_bytes(content)
            original = {
                'hermes-light-3b42157.exe': b'synthetic opaque client bytes, never executed',
                'resources/app.asar': b'synthetic opaque app bytes, never executed',
                'resources/app.asar.unpacked/dist/assets/capabilities-fixture.js': b'// synthetic renderer fixture\n',
                'HERMES-LICENSE.txt': b'synthetic license fixture',
                'VOICE-NOTE-LICENSE.txt': b'synthetic license fixture',
                'voice-note-plugin/plugin.js': b'old fixture plugin',
                'WINDOWS-CLIENT.ru.md': b'old fixture manual instructions',
            }
            base = root / 'base.zip'
            with zipfile.ZipFile(base, 'w') as archive:
                for name, content in original.items():
                    archive.writestr(name, content)
            base_hash = hashlib.sha256(base.read_bytes()).hexdigest()
            output = root / 'delivery.zip'
            module.package_delivery(base, output, source, base_hash)
            with zipfile.ZipFile(output) as archive:
                self.assertIsNone(archive.testzip())
                for name, content in original.items():
                    if name not in {'voice-note-plugin/plugin.js', 'WINDOWS-CLIENT.ru.md'}:
                        self.assertEqual(archive.read(name), content, name)
                self.assertEqual(archive.read('Start-Voice-Note.cmd'), payload['install/Start-Voice-Note.cmd'])
                self.assertEqual(archive.read('voice-note-delivery/Start-Voice-Note.ps1'), payload['install/Start-Voice-Note.ps1'])
                self.assertEqual(archive.read('voice-note-plugin/plugin.js'), payload['plugin.js'])
                manifest = json.loads(archive.read('voice-note-delivery/manifest.json'))
                self.assertEqual(manifest['schemaVersion'], 1)
                self.assertEqual(manifest['pluginId'], 'hermes-voice-note')
                self.assertEqual(manifest['executable'], 'hermes-light-3b42157.exe')
                self.assertEqual(manifest['basePackageSha256'], base_hash)
                required = set(original) - {'HERMES-LICENSE.txt', 'VOICE-NOTE-LICENSE.txt', 'WINDOWS-CLIENT.ru.md'}
                self.assertEqual(set(manifest['files']), required)
                for name, expected in manifest['files'].items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), expected, name)


if __name__ == '__main__':
    unittest.main()
