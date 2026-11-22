---
"@reelsaw/server": minor
---

Follow the person who is talking in two-person shots with a learned audio-visual model (LR-ASD, 3.4 MB, on the CPU) instead of mouth motion alone. A listener who laughs, smiles or drinks is no longer taken for the talker, and when only one person is on camera an off-camera interviewer's turns are recognised. A sign or poster the face detector mistakes for a face no longer makes a two-shot look like three people. The previous heuristic remains as the fallback (`ASD_MODEL=false`, or when the model files are missing); `reelsaw machine` and Settings → System show which one runs.
