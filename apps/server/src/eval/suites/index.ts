/** Suite registry: add new suites here (order = default run order, cheapest first). */
import type { Suite } from "../framework.js";
import { transcriptionSuite } from "./transcription.js";
import { cutsSuite } from "./cuts.js";
import { overlaysSuite } from "./overlays.js";
import { framingSuite } from "./framing.js";
import { scenesSuite } from "./scenes.js";
import { pausesSuite } from "./pauses.js";
import { alignmentSuite } from "./alignment.js";
import { speakersSuite } from "./speakers.js";
import { selectionSuite, selectionModelSuite } from "./selection.js";
import { disfluencySuite } from "./disfluency.js";
import { asrLoopsSuite } from "./asr-loops.js";
import { decisionsSuite } from "./decisions.js";
export const suites: Suite[] = [selectionSuite, framingSuite, asrLoopsSuite, scenesSuite, pausesSuite, alignmentSuite, speakersSuite, overlaysSuite, cutsSuite, transcriptionSuite, disfluencySuite, decisionsSuite, selectionModelSuite];
