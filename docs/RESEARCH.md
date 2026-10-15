# Reelsaw: Competitor Audit and Research Review (Oct 2026)

**Scope:** what competitors do that Reelsaw doesn't yet do, and what 2021–2026 research suggests for each pipeline stage. Every source below is linked. Figures from vendor marketing pages are marked *(vendor claim)*.

---

## PART A: Competitor audit

### A1. What each competitor does that's relevant to us

| Product | Notable capabilities beyond Reelsaw | Clip count | Reframe control |
|---|---|---|---|
| **OpusClip** | Virality score 0–99 built from **Hook / Flow / Value / Trend** sub-grades. A ClipAnything prompt makes it clip only what the prompt describes. Settings for timeframe, length buckets (0–1m … 10–15m) and "reprompt". Animated caption templates with auto emoji and keyword highlights. Brand templates, AI B-roll, dubbing, social scheduler, 9:16 / 1:1 / 16:9 export ([virality score](https://help.opus.pro/docs/article/virality-score), [pricing](https://opus.pro/pricing)) | **Depends on content and length**: about 1–2 clips for under 3 min of source, about 5–21 for 10–30 min ([FAQ](https://help.opus.pro/docs/article/get-clips-faq)) | ReframeAnything tracks speakers and objects automatically. Manual crop is per scene (press X or double-click; Shift-select several scenes and apply one layout). Users can't pick the tracking target ([manual reframe](https://help.opus.pro/docs/article/how-to-manually-reframe-content.md), [face tracking](https://help.opus.pro/docs/article/how-to-enable-face-tracking)) |
| **Vizard** | ASD that combines voice activity, facial movement and speaker transitions. AI B-roll. Brand kit ([ASD blog](https://vizard.ai/blog/vizard-now-automatically-centers-the-active-speaker)) | API has `maxClipNumber` (a cap) and `preferLength` (0 = auto). The count otherwise depends on content. `clip_v2` returns fewer, more curated clips ([docs](https://docs.vizard.ai/docs/basic), [help](https://help.vizard.ai/en/articles/8767566-how-many-clips-can-ai-generate), [v2](https://vizard.ai/blog/api-update-vizard-now-supports-the-v2-ai-clipping-model)) | Frames the active speaker automatically |
| **Klap** | "Reframe 2" detects zones such as webcam vs. screen, then follows the active face, or a **saliency point** when there's no face. Auto split or multi-screen layouts for podcasts ([Klap](https://klap.app/tools/youtube-clip-maker), [podcast](https://klap.app/tools/podcast-clip-maker)) | Roughly proportional to source length: about 10–15 per hour, 20–40 for episodes over 2h *(vendor claim)* | Automatic |
| **Submagic** | Captions with emoji and keyword highlights plus animation. **Magic Zoom** places zooms from the transcript (smooth / crash / expo / linear), editable. Contextual B-roll with a frequency slider. **Smart Trim** removes silence, fillers and bad takes. Each step can be toggled ([auto editor](https://www.submagic.co/it/features/auto-video-editor), [auto zooms](https://submagic.co/features/auto-zooms)) | Not a clipper first | n/a |
| **Munch** | Trend-aware selection: CV and NLP extract about 1,000 features, which are matched against social and marketing trends *(vendor claim)* ([MAII](https://marketingaiinstitute.com/blog/munch-spotlight)) | n/a | Automatic |
| **Descript** | AI clip finder. Studio Sound (regenerative speech enhancement). Eye contact correction. Filler removal ([Studio Sound](https://descript.com/studio-sound), [filler](https://www.descript.com/tools/remove-filler-from-audio)) | Not documented | Manual editor |
| **Riverside Magic Clips** | 30–90s clips, plus "Magic Segments" of 3–10 min. **Keyword/topic focus** and **speaker focus** when you generate more clips ([support](https://support.riverside.com/hc/en-us/articles/12124048765981)) | Content-driven (for example, 8 clips from a 45-min webinar), and users can generate more | Speaker-focus option |
| **Gling** | Bad-take and retake removal, silence and filler removal, text-based trimming, auto-framing ([Gling](https://gling.ai/silence-remover)) | n/a (focus is long-form cleanup) | n/a |
| **CapCut AutoCut** | Long-to-shorts with a user-set target length. Silence and dead-air removal based on audio and visual cues ([CapCut](https://www.capcut.com/resource/autocut-for-videos)) | User picks the segment and length | Auto reframe (Commerce Pro) |
| **OpenShorts** (MIT) | faster-whisper, PySceneDetect, then Gemini picks moments. MediaPipe face tracking with a YOLOv8 fallback. Hook overlays. ElevenLabs dubbing in 30+ languages. Upload-Post publishing ([repo](https://github.com/mutonby/openshorts)) | **Fixed range of 3–15** | Automatic |
| **ClipsAI** (MIT, Python) | Resizes using **pyannote diarization + scene detection + face detection** to find who is speaking. Known issue: cuts between speakers look glitchy ([repo](https://github.com/ClipsAI/clipsai), [resize](https://clipsai.com/references/resize)) | Topic segmentation | Automatic |
| **FunClip** (Alibaba, MIT) | Paraformer ASR with **hotwords**. **CAM++ speaker ID**, so users can clip by speaker. LLM picks clips from the SRT ([repo](https://github.com/joephon/FunClip)) | LLM-driven | n/a |
| imgly/videoclipper | Runs in the browser: Whisper, then Gemini, with face-api.js tracking ([repo](https://github.com/imgly/videoclipper)) | LLM-driven | Automatic |

**How competitors decide clip count.** Commercial tools almost all let content and length drive the count, with a user-set cap and length bucket on top (OpusClip, Vizard, Klap, Riverside). OpenShorts uses a fixed 3–15. Our current approach is one LLM pass plus top-up passes when it finds too few, so we sit between the two. The clearest pattern to copy is Vizard and OpusClip: generate **candidates above a quality threshold**, let the user set an optional `maxClips` and a length bucket, and offer "find more" or "reprompt" (Riverside and OpusClip both have this).

**Reframing control UX.** No product I found lets users keyframe a crop path or click to choose which face to track. The best pattern on offer is OpusClip's **per-scene layout and crop override with multi-select batch apply**. Reelsaw already has a per-clip layout override. Moving it to per-scene, keyed to our ffmpeg scene cuts, would match the best competitor. Adding "click a face to lock tracking" would put us ahead.

**Caption positioning UX.** I found no public docs from OpusClip or Submagic on dragging captions into position. What they document is template, font, colour, animation and position presets saved into a brand kit ([OpusClip](https://www.opus.pro/tools/instagram-reel-caption-generator)). Third-party safe-zone guides for 1080×1920 disagree: the bottom reserve ranges from about 250–660 px and the right action rail is about 120 px ([Remotion safe zones](https://www.remotion.dev/elements/overlays/social-safe-zones/)). Recommendation: offer a vertical-position slider with a safe-zone overlay toggle, and default captions to roughly 60–70% of frame height.

### A2. Feature gaps ranked by impact × effort (self-hosted TypeScript)

Impact and effort are scored 1–5. Rank is ordered by roughly impact ÷ effort.

| # | Gap | Impact | Effort | Notes |
|---|---|---|---|---|
| 1 | **Rubric-based virality sub-scores** (hook / flow / value / trend + reasoning) | 4 | 1 | Prompt and schema change only. OpusClip shows sub-grades, and users trust a score more when they can see what it's made of |
| 2 | **Keyword-highlight + emoji captions, word-pop animation** | 5 | 2 | ASS `\t` transforms and colour overrides already work. The LLM tags emphasis words once per clip |
| 3 | **Silence / dead-air trimming** | 4 | 1–2 | We already have jump cuts and crossfades. Add Silero VAD (ONNX) or ffmpeg `silencedetect` |
| 4 | **Prompted / topic-focused clipping + length bucket + maxClips** | 4 | 2 | Riverside keywords, OpusClip ClipAnything |
| 5 | **Active speaker detection** (choose a face, not only "a face") | 5 | 3 | Needed for 2+ person podcasts. See B5 |
| 6 | **Auto punch-in zooms** on emphasis words | 4 | 2 | Same keyword tags as #2. Animate the crop scale in our existing crop expression |
| 7 | **Brand templates** (caption style, fonts, logo, hook style presets) | 3 | 2 | Saved JSON presets |
| 8 | **Multi-aspect export** (1:1, 4:5, 16:9) | 3 | 2 | The layout engine is already parametric |
| 9 | **Per-scene reframe overrides** | 4 | 3 | Scene cuts already exist |
| 10 | **Audio enhancement** (loudness normalise, denoise) | 3 | 1–3 | ffmpeg `loudnorm` + `afftdn`/`arnndn` is cheap. Regenerative enhancement like Studio Sound is hard |
| 11 | **Publishing / scheduling** (YouTube Data API, TikTok Content Posting API) | 3 | 3 | OAuth and app review overhead |
| 12 | **B-roll insertion** (stock API such as Pexels, or user library, matched by LLM keywords) | 3 | 4 | High polish, but quality is hard to get right |
| 13 | Translation + translated captions | 3 | 2 | LLM translation of the caption track is cheap. **Dubbing** costs 4 (TTS plus timing) |
| 14 | Background music with ducking | 2 | 2 | Licensing questions |
| 15 | Eye contact correction | 1 | 5 | Skip |

---

## PART B: Research and emerging techniques, by pipeline stage

### B1. Transcription and word-level alignment (replaces "re-transcribe the seam")
- **Finding:** VAD-based chunking plus phoneme forced alignment gives accurate word timestamps and a 12× batched speedup over Whisper's sequential long-form decoding. **Cite:** WhisperX, *Time-Accurate Speech Transcription of Long-Form Audio* (Interspeech 2023), https://arxiv.org/abs/2303.00747
- **Finding:** Fine-tuning Whisper for *verbatim* output, plus a tokenizer change so DTW over cross-attention gives precise timings, reaches state of the art on timed filler detection and segments repetitions and false starts. **Cite:** CrisperWhisper (Interspeech 2024), https://arxiv.org/abs/2408.16589. Weights are CC-BY-NC.
- **Finding:** MMS_FA is a CTC aligner covering 1,100+ languages. **Cite:** torchaudio tutorial, https://docs.pytorch.org/audio/2.8/tutorials/forced_alignment_for_multilingual_data_tutorial.html. An ONNX export exists ([HF](https://huggingface.co/tatsu020/mms-300m-fa-onnx)), but it's CC-BY-NC and torchaudio is deprecating these APIs.
- **Recommendation:** Add a **CTC forced-alignment pass** that only runs over the ±1.5 s window around each jump cut and caption word. Use it to place cuts at phone boundaries and keep re-transcription as a fallback check. In Node this runs as an English wav2vec2-base CTC ONNX model (Apache/MIT checkpoints exist) through `onnxruntime-node`, with Viterbi alignment written in TS (about 100 lines). **Feasibility:** CPU-only, Node/ONNX, moderate effort. Check the license before using MMS or CrisperWhisper weights commercially.

### B2. Disfluency detection
- **Finding:** On Switchboard, LLMs used for disfluency removal tend to **over-delete fluent tokens**, especially reasoning models. Fine-tuning helps precision but hurts generalisation. The paper gives deployment recommendations. **Cite:** DRES benchmark (2025), https://arxiv.org/abs/2509.20321
- **Finding:** Prompted LLM removal of repetitions and fillers in ASR transcripts works in practice. **Cite:** de Lima & Campelo, STIL 2024, https://aclanthology.org/2024.stil-1.16.pdf
- **Recommendation:** Keep the rewrite-and-diff approach, but add **deletion-budget guards**: reject diffs that delete content words or more than about 15% of tokens in a span, and require the rule-based detector or the audio (VAD gap, repeated n-gram) to agree. Ask the LLM for *labelled spans* (filler / repetition / false start) rather than a free rewrite. **Feasibility:** AI SDK, low effort.

### B3. Highlight detection and moment retrieval
- **Finding:** QVHighlights / Moment-DETR treat this as query-conditioned moment retrieval plus clip-level saliency, and ASR-caption pretraining helps a lot. **Cite:** Lei et al., NeurIPS 2021, https://arxiv.org/abs/2107.09609
- **Finding:** UniVTG unifies moment retrieval, highlight detection and summarisation, and can do zero-shot grounding. **Cite:** ICCV 2023, https://arxiv.org/abs/2307.16715. Lighthouse packages six of these models with an inference API. **Cite:** EMNLP 2024 demo, https://arxiv.org/abs/2408.02901
- **Finding:** Time-aware video LLMs such as TimeChat (CVPR 2024, https://arxiv.org/abs/2312.02051), and MLLMs that emit per-frame saliency tokens (https://arxiv.org/abs/2512.12246), improve QVHighlights HIT@1. However, zero-shot "subjective rating" from video LLMs is often invalid or inaccurate ([HiVid 2026](https://arxiv.org/abs/2602.14214)).
- **Recommendation:** Don't self-host these models. They're GPU-bound Python, and our domain is talking-heads, where text carries most of the signal. The idea worth borrowing is the **query-conditioned saliency curve**: let the user prompt "moments about X" (matching Riverside and OpusClip), score transcript windows, and pick peaks. For visual-heavy sources, optionally send the candidate window to a **multimodal model through the AI SDK** (for example Gemini, which accepts video plus audio and returns MM:SS timestamps, https://ai.google.dev/gemini-api/docs/audio) as a *re-ranker*, never as the first-pass selector. **Feasibility:** AI SDK provider. Cost scales with the number of candidates.

### B4. Clip selection strategy (long context, ranking, judging)
- **Finding:** Accuracy drops for information in the middle of long contexts. **Cite:** *Lost in the Middle* (TACL 2024), https://arxiv.org/abs/2307.03172. Implication: one whole-transcript pass under-selects from the middle of a 2-hour episode.
- **Finding:** Pairwise ranking prompts beat pointwise and listwise ranking, are insensitive to input order, and have linear-cost variants. **Cite:** Qin et al., NAACL Findings 2024, https://arxiv.org/abs/2306.17563
- **Finding:** Sampling several reasoning paths and voting (self-consistency) improves robustness. **Cite:** Wang et al., ICLR 2023, https://arxiv.org/abs/2203.11171. LLM judges have **position and verbosity bias**, which swapping positions mitigates. **Cite:** Zheng et al., NeurIPS 2023, https://arxiv.org/abs/2306.05685
- **Recommendation:** Change selection to **map → pool → rank**:
  1. Chunk the transcript into topic segments with about 20% overlap and generate candidates per chunk. This removes the need for top-up passes.
  2. Deduplicate overlapping candidates.
  3. Score each candidate pointwise with a rubric (hook / flow / value / standalone-ness), using k=3 samples and taking the median.
  4. Run a pairwise tournament on the top N with position swapping to get the final order.
  5. Let the count follow a score threshold plus the user's `maxClips` cap.
  
  **Feasibility:** AI SDK only. Use a cheap model for map and scoring, and a strong model for pairwise ranking.

### B5. Transcript segmentation and topic boundaries
- **Finding:** Embedding plus divisive clustering gives hierarchical segmentation of large, noisy ASR transcripts. **Cite:** TreeSeg (2024), https://arxiv.org/abs/2407.12028. Zero-shot LLM prompting and LoRA fine-tuning, plus **pause features**, improve multi-level transcript segmentation. **Cite:** Freisinger et al., Interspeech 2025, https://arxiv.org/abs/2601.02128
- **Recommendation:** Combine three signals into one boundary score: an embedding-similarity dip (AI SDK `embedMany`, TextTiling style), long pauses from word timestamps, and the YouTube chapters we already ingest. Use the segments both as map chunks for B4 and as hard limits on where clips can start and end, alongside sentence snapping. **Feasibility:** AI SDK embeddings, low effort.

### B6. Virality and engagement prediction
- **Finding:** Fine-tuned LMMs on SnapUGC predict short-video engagement. The model that uses **audio** (VideoLLaMA2) beats the frames-only Qwen2.5-VL, and their ensemble won the ICCV 2025 EVQA challenge. **Cite:** Sun et al. 2025, https://arxiv.org/abs/2508.02516. Background music, visuals and text all contribute. **Cite:** Li et al., *Delving Deep into Engagement Prediction of Short Videos*, ECCV 2024, https://mlanthology.org/eccv/2024/li2024eccv-delving
- **Finding:** Converting visuals to text lets plain LLMs predict popularity well. **Cite:** Kayal et al., *LLMs Are Natural Video Popularity Predictors*, ACL Findings 2025, https://dare.uva.nl/id/89cb9b43-0a5f-4732-b786-5ba329cd6179
- **Recommendation:** Present the score honestly as a **rubric score, not a prediction**. OpusClip says its model trains on clip/performance pairs from TikTok, Reels and Shorts, and we have no such data. Add cheap non-LLM features to the rubric: laughter density (B8), speech-rate and energy peaks, presence of a question or hook in the first 3 s, and face-on-screen ratio. Log what users export or delete so we can later **calibrate** scores with a small logistic model on our own data. **Feasibility:** CPU in TS; no model to train yet.

### B7. Active speaker detection (ASD)
- **Finding:** TalkNet, with long-term audio-visual temporal context, beat prior state of the art by 3.5% on AVA-ActiveSpeaker. **Cite:** ACM MM 2021, https://arxiv.org/abs/2107.06592. LoCoNet reaches 95.2 mAP on AVA, but it's heavy. **Cite:** CVPR 2024, https://arxiv.org/abs/2301.08237
- **Finding:** **Light-ASD** reaches 94.1 mAP with about **1.0M parameters and 0.6 GFLOPs** (23× fewer parameters than the previous state of the art). It uses 2D/3D-split convolutions and a GRU, and the PyTorch weights are public. **Cite:** CVPR 2023, https://openaccess.thecvf.com/content/CVPR2023/html/Liao_A_Light_Weight_Model_for_Active_Speaker_Detection_CVPR_2023_paper.html, code at https://github.com/Junhua-Liao/Light-ASD. The extension LR-ASD appeared in IJCV 2025. A robotics team cut Light-ASD's end-to-end latency about 85% by doing preprocessing in memory and switching to MediaPipe face detection ([arXiv 2407.11915](https://arxiv.org/abs/2407.11915)). That suggests most of the cost is in the pipeline, not the model.
- **Feasibility in Node:** **Yes, likely.** Inputs are MFCCs plus 112×112 grayscale mouth/face crops, which are standard ops. Conv layers and the GRU export with `torch.onnx.export` (opset ≥ 14). I found no existing ONNX export, so expect a one-off Python export step. We already have UltraFace tracks, so per-track ASD is a natural fit: run it at about 5 fps on candidate clips only.
- **Cheaper interim option:** `sherpa-onnx-node` runs **pyannote-3.0 segmentation + speaker-embedding diarization** in Node through ONNX Runtime ([npm](https://www.jsdelivr.com/package/npm/sherpa-onnx-node), [LocalAI notes](https://localai.io/docs/features/audio-diarization/)). Map diarized speakers to face tracks by correlating speech turns with mouth-region motion. This is the ClipsAI approach. Add hysteresis or a minimum shot length to avoid the "glitchy speaker cuts" ClipsAI reports.

### B8. Saliency-based reframing
- **Finding:** AutoFlip chooses **stationary, panning or tracking** per scene from detected objects and faces, and resets at scene changes. **Cite:** Google, 2020, https://research.google/blog/autoflip-an-open-source-framework-for-intelligent-video-reframing/. A fast saliency-plus-clustering cropper and a public benchmark dataset for video cropping. **Cite:** Apostolidis & Mezaris, ICIP 2021, https://rc.signalprocessingsociety.org/conferences/icip-2021/spsicip21vid109
- **Recommendation:** Our "heavy tripod" smoothing roughly covers AutoFlip's stationary and panning modes. Make the **mode an explicit per-scene decision**: lock the crop when face motion variance is low, pan when it's moderate, cut when it's large. Add a fallback for scenes with no face: a saliency centroid from frame differencing or a tiny saliency ONNX model, as Klap's Reframe 2 does. Swapping ffmpeg scene detection for **TransNet V2** gives more accurate shot cuts (F1 96.2 on BBC Planet Earth). **Cite:** https://arxiv.org/abs/2008.04838. A PyTorch port exists, but I found no ONNX export, so that's an export task. **Feasibility:** CPU/ONNX, medium effort.

### B9. Audio events and laughter as engagement signals
- **Finding:** YAMNet covers 521 AudioSet classes including laughter, giggle and chuckle, and runs on 0.96 s frames with a 0.48 s hop. **Cite:** TF tutorial, https://www.tensorflow.org/tutorials/audio/transfer_learning_audio. Laughter detectors trained on clean audio degrade in noise. Robust training plus AudioSet laughter annotations fix this. **Cite:** Gillick et al., *Robust Laughter Detection in Noisy Environments*, Interspeech 2021, https://www.isca-archive.org/interspeech_2021/gillick21_interspeech.html
- **Recommendation:** Run YAMNet (about 3.7M parameters; convert TFLite to ONNX) over the whole audio once on CPU. Produce `laughter`, `applause`, `cheering` and `shout` timelines, insert them into the LLM transcript as inline tags such as `[laughter 0.8]`, and add them to the rubric. Laughter in the 2–3 s right after a line is a strong payoff marker. **Feasibility:** Node/ONNX, CPU, low–medium effort.

### B10. Caption readability
- **Finding:** Viewers keep up with subtitles at 12, 16 and 20 cps. Slower subtitles caused more re-reading and were liked less. **Cite:** Szarkowska & Gerber-Morón, PLOS ONE 2018, https://discovery.ucl.ac.uk/id/eprint/10050653/. L2 viewers struggle more at high speeds ([Szarkowska et al. 2025](https://ueaeprints.uea.ac.uk/id/eprint/100082/1/6_Szarkowska_et_al.pdf)). At 20 cps, about 45% of display time goes to reading ([Aston re-analysis](https://research.aston.ac.uk/en/publications/effects-of-subtitle-speed-on-proportional-reading-time-re-analysi/)).
- **Finding:** Netflix uses 42 characters per line for Latin scripts, with adult reading-speed caps of about 17–20 cps depending on language ([Netflix template](https://backlothelp.netflix.com/hc/en-us/articles/219375728)).
- **Finding:** I found **no independent evidence** that animated word-by-word captions outperform static ones. All such figures come from vendors ([skeptical review](https://blitzcutai.com/blog/animated-captions-vs-static-captions)).
- **Recommendation:** Enforce caption chunking rules:
  - At most about 2 lines and 16–20 characters per line. Vertical frames are narrow, so the 42-character limit doesn't apply.
  - At most 3–5 words per chunk.
  - Minimum display about 0.7 s.
  - Cap at about 17 cps for "plain" style.
  - Break lines at syntactic boundaries.
  - Keep captions inside the safe zone.
  
  A/B-test the karaoke style yourself rather than trusting vendor numbers. **Feasibility:** pure TS.

### B11. Silence and VAD
- **Finding:** Silero VAD runs on ONNX Runtime and has a Node wrapper (`@ricky0123/vad-node`), at 16 kHz ([repo](https://github.com/ricky0123/vad)). It's also usable through `sherpa-onnx-node`.
- **Recommendation:** Use VAD for (a) silence trimming, (b) choosing chunk boundaries for STT, the WhisperX "cut & merge" trick, and (c) a pause feature for segmentation and hooks. **Feasibility:** CPU, low effort.

---

## Top 10 next moves (prioritised)

> **Status (2026-10-15):** #1 (map → pool → rank), #2 (rubric sub-scores + focus + length buckets + maxClips) and #3 (emphasis captions + readability rules + safe-zone overlay) are implemented. Per-scene reframe overrides (#10, manual part) and drag-to-recentre are implemented too.

1. **Map → pool → rank clip selection** (B4, B5): overlapping topic-segment chunks, rubric scoring with k=3 median, pairwise tournament with position swap, and a count driven by threshold plus `maxClips`. This fixes "lost in the middle" and replaces top-up passes. *AI SDK, about 1 week.*
2. **Rubric sub-scores + prompted/topic clipping + length bucket** (A #1, #4): matches the OpusClip, Riverside and Vizard UX. *Low effort.*
3. **Keyword-emphasis captions + readability rules + safe-zone slider** (A #2, B10): LLM-tagged emphasis words, word-pop and colour in ASS, enforced cps and line limits. *Low–medium.*
4. **Silero VAD → silence trimming + VAD-based chunking** (B11, A #3): reuses the existing jump-cut and crossfade path. *Low.*
5. **Windowed CTC forced alignment around cuts and caption words** (B1): more accurate seams and karaoke timing, with re-transcription kept as a check. Choose a commercially licensed wav2vec2 checkpoint. *Medium.*
6. **Disfluency safety rails** (B2): span labels instead of free rewrites, a deletion budget, and audio corroboration. *Low.*
7. **Active speaker selection**: sherpa-onnx diarization mapped to UltraFace tracks now (B7), then a Light-ASD ONNX export later. Add hysteresis or a minimum shot length. *Medium → high.*
8. **Auto punch-in zooms** on the emphasis words from #3 (A #6). *Low–medium.*
9. **YAMNet laughter/applause timeline** fed into the transcript and rubric (B9). *Medium.*
10. **Per-scene reframe overrides plus per-scene AutoFlip-style mode** (static, pan or track, saliency fallback when there's no face), with a "click face to lock" control in the clip editor (A1, B8). *Medium–high.* After that: brand presets, multi-aspect export, publishing APIs, then B-roll.

**Caveats:** Competitor clip counts, caption-retention lifts and plan details mostly come from vendor pages and weren't independently verified. I found no public ONNX export for Light-ASD or TransNet V2. MMS-FA and CrisperWhisper weights are CC-BY-NC.
