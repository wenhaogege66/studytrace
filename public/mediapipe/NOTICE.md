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
- Runtime license: <https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE>

No third-party model CDN is contacted by the running application. Local object
detection is an auxiliary signal; an object merely being visible is not an
agreement violation. Cloud sequence analysis, if separately authorized, is a
different processor and never receives local face landmarks.
