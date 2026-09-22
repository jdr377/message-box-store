"""Independent cross-language verification for vectors/m1-golden.json.

Uses only the Python standard library (hashlib, struct, json). It is a test
oracle, never a runtime dependency: it recomputes every bodyHash/recordKey
from the vector inputs and fails on any mismatch.

Usage: python3 vectors/verify.py [path-to-golden-json]
"""

import hashlib
import json
import struct
import sys

DOMAIN = 'message-box-store:record:v1'
FIELD_ORDER = ['ownerIdentityKey', 'direction', 'messageBox', 'sender', 'recipient', 'messageId']


def length_prefixed(fields):
    chunks = []
    for field in fields:
        raw = field.encode('utf-8')
        chunks.append(struct.pack('>I', len(raw)))
        chunks.append(raw)
    return b''.join(chunks)


def record_key(vector):
    ordered = [DOMAIN] + [vector[name] for name in FIELD_ORDER]
    return hashlib.sha256(length_prefixed(ordered)).hexdigest()


def body_hash(body):
    return hashlib.sha256(body.encode('utf-8')).hexdigest()


def main(path='vectors/m1-golden.json'):
    with open(path, encoding='utf-8') as handle:
        golden = json.load(handle)
    assert golden['version'] == 1, 'unsupported golden version'
    assert golden['domain'] == DOMAIN, 'domain mismatch'
    failures = 0
    for vector in golden['vectors']:
        expected_key = record_key(vector)
        expected_hash = body_hash(vector['body'])
        ok = expected_key == vector['recordKey'] and expected_hash == vector['bodyHash']
        print(f"{'ok' if ok else 'MISMATCH'} {vector['name']}")
        if not ok:
            failures += 1
            print(f"  recordKey: computed {expected_key} expected {vector['recordKey']}")
            print(f"  bodyHash:  computed {expected_hash} expected {vector['bodyHash']}")
    if failures:
        print(f'{failures} vector(s) mismatched')
        return 1
    print(f"{len(golden['vectors'])} vectors verified")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'vectors/m1-golden.json'))
