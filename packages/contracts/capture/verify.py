"""Check schema validity, cross-language evidence fixtures and native asset identity.

Run: uv run --no-project --with jsonschema==4.25.1 python packages/contracts/capture/verify.py
"""
from __future__ import annotations

import hashlib
import json
import argparse
from pathlib import Path

from jsonschema import Draft202012Validator


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mcap', nargs='*', type=Path, default=[], help='Also validate actual emitted H.264 MCAP contracts; add --with mcap==1.6.0 to uv')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    native = root.parents[2] / 'packages/stera_recorder/android/src/main/assets/stateaction/capture'
    manifest = json.loads((root / 'manifest.json').read_text())
    for name, expected in manifest['files'].items():
        source = (root / name).read_bytes()
        assert hashlib.sha256(source).hexdigest() == expected, f'Contract hash mismatch: {name}'
        assert (native / name).read_bytes() == source, f'Native asset drift: {name}'
    validators = {}
    for file in root.glob('*.schema.json'):
        schema = json.loads(file.read_text())
        Draft202012Validator.check_schema(schema)
        validators[file.name.removesuffix('.schema.json')] = Draft202012Validator(schema)
    fixture = json.loads((root / 'fixtures/protocol.json').read_text())
    count = 0
    for name, validator in validators.items():
        for event in fixture.get(name, []):
            validator.validate(event)
            count += 1
    original = fixture['FrameEvent'][0]
    assert int(original['mapped_capture_time_ns']) > 2**53
    for invalid in [original | {'source_frame_id': 0}, original | {'encoder_pts_us': 0},
                    original | {'native_timestamp_ns': '-1'}, original | {'state': 'encoded'}]:
        assert not validators['FrameEvent'].is_valid(invalid), f'Invalid fixture admitted: {invalid}'
    actual_counts = {}
    sources = []
    if args.mcap:
        from mcap.reader import make_reader
        by_schema_name = {f'stateaction.capture.{name}.v1': validator for name, validator in validators.items()}
        for path in args.mcap:
            checked_schemas = set()
            with path.open('rb') as source:
                reader = make_reader(source)
                assert reader.get_header().profile == '', f'Expected generic mixed-encoding MCAP: {path}'
                for schema, channel, message in reader.iter_messages():
                    if schema is not None and schema.name == 'foxglove.CompressedVideo' and schema.name not in checked_schemas:
                        assert hashlib.sha256(schema.data).hexdigest() == manifest['files']['foxglove-compressed-video.desc'], 'Emitted video descriptor drift'
                        checked_schemas.add(schema.name)
                    if schema is None or schema.name not in by_schema_name:
                        continue
                    if schema.name not in checked_schemas:
                        short_name = schema.name.split('.')[-2]
                        assert schema.data == (root / f'{short_name}.schema.json').read_bytes(), f'Emitted schema drift: {schema.name}'
                        checked_schemas.add(schema.name)
                    by_schema_name[schema.name].validate(json.loads(message.data))
                    actual_counts[schema.name] = actual_counts.get(schema.name, 0) + 1
            with path.open('rb') as source:
                sources.append({'path': str(path), 'sha256': hashlib.file_digest(source, 'sha256').hexdigest()})
    print(json.dumps({'schemas': len(validators), 'conformance_events': count,
                      'rejected_mutations': 4, 'native_assets_match': True,
                      'sources': sources, 'actual_messages': actual_counts,
                      'descriptor_sha256': manifest['files']['foxglove-compressed-video.desc']}))


if __name__ == '__main__':
    main()
