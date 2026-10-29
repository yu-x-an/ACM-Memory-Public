# Third-party notices

ACM Memory itself is licensed under the MIT license in [LICENSE](LICENSE). It
ships vendored third-party components so the store works offline. Those
components stay under their own licenses, and this file records what they are,
where they came from and what a redistribution has to preserve.

This is an audit record, not legal advice. Confirm the terms before making the
repository public.

## Vendored components

| Component | Version | License | Copyright | Where it lives |
| --- | --- | --- | --- | --- |
| onnxruntime-web | 1.31.1 | MIT | Microsoft Corporation | `lib/vendor/ort/node_modules/onnxruntime-web/` |
| onnxruntime-common | 1.31.1 | MIT | Microsoft Corporation | `lib/vendor/ort/node_modules/onnxruntime-common/` |
| BAAI/bge-small-zh-v1.5 (quantized ONNX export) | model card `BAAI/bge-small-zh-v1.5` | MIT, as declared on the upstream model card | Beijing Academy of Artificial Intelligence (BAAI) | `lib/vendor/bge-small-zh/` |

The MIT text for the runtime is vendored at `lib/vendor/ort/LICENSE`, fetched
from `https://raw.githubusercontent.com/microsoft/onnxruntime/main/LICENSE`
(`Copyright (c) Microsoft Corporation`).

The model directory contains a BertModel configuration (`hidden_size` 512, four
layers, vocab 21128), a quantized ONNX graph and a base64-encoded WordPiece
vocabulary. The files were supplied by the repository owner rather than
downloaded by this project, so their provenance is recorded by hash rather than
by fetch URL. Their license is declared by the model card
(`https://huggingface.co/BAAI/bge-small-zh-v1.5`, front matter `license: mit`);
the MIT text with the BAAI attribution is vendored at
`lib/vendor/bge-small-zh/LICENSE`.

## Recorded hashes

These hashes are asserted by `scripts/check-third-party.mjs`, which hashes the
**committed blob** rather than the local file: a Windows checkout rewrites line
endings, and a hash that depends on checkout settings would be useless. If an
asset is replaced, the audit has to be redone and this table updated.

| File | SHA-256 |
| --- | --- |
| `lib/vendor/bge-small-zh/model_quantized.onnx` | `15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc` |
| `lib/vendor/bge-small-zh/vocab.base64.txt` | `0a4453596e38ff537f7a944fb13da8ed75d6af2729c52ffc892d436f94787076` |
| `lib/vendor/ort/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm` | `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d` |

## Obligations before public distribution

1. Ship `lib/vendor/ort/LICENSE` and `lib/vendor/bge-small-zh/LICENSE` alongside
   the binaries; both are already in the tree.
2. Keep this file and the recorded hashes with the source tree.
3. Re-check the terms of any component added later; `scripts/check-third-party.mjs`
   fails when a vendored package declares no license, when a license file is
   missing, or when an asset no longer matches its recorded hash.

## Not vendored

`node:sqlite`, `node:crypto` and the rest of the Node.js standard library are
provided by the runtime. npm dependencies are empty, so there is no dependency
tree to audit beyond the two vendored packages above.
