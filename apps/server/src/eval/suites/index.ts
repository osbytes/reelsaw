/** Suite registry: add new suites here (order = default run order, cheapest first). */
import type { Suite } from "../framework.js";
import { transcriptionSuite } from "./transcription.js";
import { cutsSuite } from "./cuts.js";
import { overlaysSuite } from "./overlays.js";
import { framingSuite } from "./framing.js";
import { selectionSuite, selectionModelSuite } from "./selection.js";
export const suites: Suite[] = [selectionSuite, framingSuite, overlaysSuite, cutsSuite, transcriptionSuite, selectionModelSuite];
