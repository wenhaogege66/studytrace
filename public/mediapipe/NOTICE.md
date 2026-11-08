# MediaPipe runtime assets

The files in this directory are downloaded from the official MediaPipe Tasks
Vision npm package and model bucket. MediaPipe is licensed under Apache-2.0.

- Runtime package: `@mediapipe/tasks-vision@1.0.1`
- Model: `face_landmarker.task` (float16, latest at acquisition time)
- SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`
- Source: <https://developers.google.com/mediapipe/solutions/vision/face_landmarker/web_js>

These files are loaded only when a user explicitly enables the camera feature.

## Auxiliary object detector

- Model: EfficientDet-Lite0 float32, version 1 (COCO categories, locally used only for `person` and `cell phone`). It does not identify tablets or prove how a device is used.
- Official download: <https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite>
- SHA-256: `40338edf5ec70d43e318b0a716a84d4564cd1802759a7a07170c7e43796dbf58`
- Official model description: <https://developers.google.com/edge/mediapipe/solutions/vision/object_detector#models>
- Upstream EfficientDet-Lite0 licensing evidence: TensorFlow's public model metadata lists Apache 2.0 for Lite0 version 1 (including its TFLite metadata and int8 variants): <https://www.kaggle.com/models/tensorflow/efficientdet/TfLite/lite0-detection-metadata>. Machine-readable metadata: <https://www.kaggle.com/api/v1/models/list?search=efficientdet&owner=tensorflow>. The bundled Google-hosted float32 build is not claimed to be byte-identical to a quantized Kaggle variant, and the Google binary bucket supplies no separate model license file.
- Runtime license: <https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE>
- A copy of the upstream license is included in `LICENSE.txt`. This notice covers the bundled third-party assets, not the StudyTrace application source.

No third-party model CDN is contacted by the running application. Local object
detection is an auxiliary signal; an object merely being visible is not an
agreement violation. Cloud sequence analysis, if separately authorized, is a
different processor and never receives local face landmarks.

## Existing runtime integrity

The WASM/JS files remain unmodified from the pinned npm runtime package above.
SHA-256 checks performed on 2026-11-08:

```
e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73  wasm/vision_wasm_internal.js
8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886  wasm/vision_wasm_internal.wasm
da8934057f147b622e82cfb4c0dbd85461c598e268588b5a8ba9ca963a8ff82d  wasm/vision_wasm_module_internal.js
2dabd8e23c60984628beb7bb338764c81a08e6837145273f59578684b5d53c1b  wasm/vision_wasm_module_internal.wasm
e81d715a3d42cc3373602eb2f7aff795d164934db680e32496b65dab537f9658  wasm/vision_wasm_nosimd_internal.js
a28483cd42e74e855bf5ebdb6b40d9b66a5b49e35e95020bc97669e6822a3192  wasm/vision_wasm_nosimd_internal.wasm
```
