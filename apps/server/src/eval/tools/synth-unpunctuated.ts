/**
 * Writes the selection suite's fixtures for clip edges on transcripts without punctuation (suites/selection.ts
 * edgeCases), each with its ground-truth sentences:
 *
 *  - `hormozi-unpunctuated`: real speech. The words and timings of `lonely-chapter` (a production STT transcript with
 *    no punctuation) with the sentence ends of `apollo` (the same video's punctuated captions) moved onto them by
 *    aligning the two word sequences.
 *  - `hindi-unpunctuated`: Hindi as most STT models return it, no punctuation at all. The text is original (written
 *    for this fixture); every gap between two words is drawn from the real gaps above, inside a sentence from the
 *    gaps inside its sentences and between sentences from the gaps between them, so the pauses are as ambiguous as
 *    real speech (a third of real sentence ends have no gap at all). Seeded, so the file is reproducible.
 *
 * Run: pnpm tsx src/eval/tools/synth-unpunctuated.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { endsSentence, type TranscriptSegment, type Word } from "@reelsaw/shared";
import { toSentences } from "../../pipeline/transcript.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../eval/fixtures/selection");
type Fixture = { durationSec: number; segments: TranscriptSegment[]; words?: Word[] };
const read = async (name: string) => JSON.parse(await fs.readFile(path.join(ROOT, name, "transcript.json"), "utf8")) as Fixture;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, "");

/** Sentence ends of `punctuated` (tokens with punctuation) moved onto `words` by their longest common subsequence. */
function transferEnds(punctuated: string[], words: Word[]): Set<number> {
  const a = punctuated.map(norm);
  const b = words.map((w) => norm(w.text));
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ends = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      if (endsSentence(punctuated[i]!)) ends.add(j);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return ends;
}

function sentencesOf(words: Word[], ends: Set<number>) {
  const out: Array<{ start: number; end: number }> = [];
  let from = 0;
  for (let k = 0; k < words.length; k++) {
    if (ends.has(k) || k === words.length - 1) {
      out.push({ start: words[from]!.start, end: words[k]!.end });
      from = k + 1;
    }
  }
  return out;
}

async function write(name: string, body: object) {
  const file = path.join(ROOT, name, "transcript.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(body, null, 1)}\n`);
  console.log(`wrote ${file}`);
}

// ---------- real speech ----------
const lonely = await read("lonely-chapter");
const apollo = await read("apollo");
const words = lonely.words!.map(({ text, start, end }) => ({ text, start, end }));
const until = words.at(-1)!.end + 5;
const tokens = apollo.segments.filter((s) => s.start < until).flatMap((s) => s.text.split(/\s+/).filter(Boolean));
const ends = transferEnds(tokens, words);
await write("hormozi-unpunctuated", {
  note: "Real speech: lonely-chapter's words and timings (production STT, no punctuation) with the sentence ends of apollo (the same video's punctuated captions) aligned onto them. `sentences` is the ground truth. Regenerate with src/eval/tools/synth-unpunctuated.ts.",
  title: "Hormozi, first 4 minutes (real timing, unpunctuated)",
  language: "en",
  durationSec: lonely.durationSec,
  segments: toSentences(words, undefined, "en"),
  words,
  sentences: sentencesOf(words, ends),
});

// the real gaps, inside sentences and between them
const inside: number[] = [];
const between: number[] = [];
for (let k = 0; k < words.length - 1; k++) (ends.has(k) ? between : inside).push(Math.max(0, words[k + 1]!.start - words[k]!.end));

// ---------- Hindi ----------
const SENTENCES = [
  "नमस्ते दोस्तों आज हम आपको पुरानी दिल्ली की सबसे मशहूर गलियों में ले चलेंगे",
  "यहाँ का खाना सौ साल से भी ज़्यादा पुराना है",
  "सबसे पहले हम चाँदनी चौक की उस दुकान पर जाएँगे जहाँ सुबह पाँच बजे से लाइन लगती है",
  "मालिक बताते हैं कि उनके दादाजी ने यह दुकान एक छोटे से ठेले से शुरू की थी",
  "आज भी वही नुस्खा इस्तेमाल होता है और कोई मशीन नहीं लगती",
  "आप देख सकते हैं कि आटा हाथ से गूँधा जा रहा है",
  "मुझे सच में नहीं पता था कि इतनी भीड़ होगी",
  "चलिए अब पहला निवाला चखते हैं",
  "वाह यह तो बिल्कुल वैसा ही है जैसा मेरी नानी बनाया करती थीं",
  "मसाला तेज़ है लेकिन जीभ नहीं जलती",
  "अगर आप पहली बार आ रहे हैं तो दोपहर से पहले आइए क्योंकि उसके बाद सब खत्म हो जाता है",
  "अब हम थोड़ा आगे चलते हैं और जलेबी वाले के पास रुकते हैं",
  "इनकी जलेबी देसी घी में बनती है और इसलिए इसका रंग थोड़ा गहरा होता है",
  "बहुत से लोग पूछते हैं कि क्या यह सेहत के लिए ठीक है",
  "मेरा जवाब है कि कभी कभी खाने में कोई बुराई नहीं है",
  "असली बात यह है कि यहाँ हर चीज़ ताज़ा बनती है",
  "यहाँ के लोग बहुत मिलनसार हैं और हर कोई आपको अपनी कहानी सुनाना चाहता है",
  "एक बुज़ुर्ग ने मुझे बताया कि वह पचास साल से रोज़ यहीं चाय पीने आते हैं",
  "सोचिए पचास साल एक ही दुकान पर",
  "यही तो इस जगह की खूबसूरती है",
  "अब बात करते हैं पैसों की क्योंकि यह सवाल आप सब पूछते हैं",
  "पूरे दिन का खाना दो सौ रुपये में आराम से हो जाता है",
  "मेट्रो से आइए क्योंकि गाड़ी खड़ी करने की जगह मिलना लगभग नामुमकिन है",
  "चाँदनी चौक स्टेशन से बाहर निकलते ही आप बाज़ार में होते हैं",
  "गर्मियों में पानी की बोतल ज़रूर साथ रखिए",
  "और हाँ अपना फ़ोन संभाल कर रखिए क्योंकि भीड़ में ध्यान भटक जाता है",
  "अगला पड़ाव है परांठे वाली गली जिसका नाम आपने ज़रूर सुना होगा",
  "यहाँ बीस से ज़्यादा तरह के परांठे मिलते हैं",
  "मैंने आलू का और पनीर का मँगवाया है",
  "साथ में तीन तरह की चटनी और आलू की सब्ज़ी आती है",
  "ईमानदारी से कहूँ तो पनीर वाला मुझे ज़्यादा पसंद आया",
  "आलू वाला थोड़ा भारी लगा लेकिन स्वाद में कोई कमी नहीं थी",
  "दुकानदार ने बताया कि सर्दियों में यहाँ और भी ज़्यादा लोग आते हैं",
  "शाम होते होते गलियों में रोशनी जगमगाने लगती है",
  "उस वक्त का माहौल बिल्कुल अलग होता है",
  "अगर आपके पास समय हो तो जामा मस्जिद की सीढ़ियों पर बैठकर सूरज ढलते देखिए",
  "वहाँ से पूरा पुराना शहर दिखता है",
  "मेरे लिए यह आज का सबसे यादगार पल था",
  "तो दोस्तों यह था हमारा पुरानी दिल्ली का सफ़र",
  "अगर आपको यह वीडियो अच्छा लगा तो बताइए कि अगली बार हम कहाँ चलें",
  "कमेंट में अपनी पसंदीदा जगह का नाम ज़रूर लिखिए",
  "मिलते हैं अगले वीडियो में तब तक के लिए खूब घूमिए और खूब खाइए",
];

/** mulberry32: a small seeded generator, so the fixture is the same on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(20261121);
const draw = (pool: number[]) => pool[Math.floor(r() * pool.length)]!;
const round = (n: number) => Number(n.toFixed(3));

const hi: Word[] = [];
const truth: Array<{ start: number; end: number }> = [];
let t = 1.2;
SENTENCES.forEach((s, si) => {
  const toks = s.split(" ");
  const start = t;
  toks.forEach((tok, i) => {
    // about three words a second, longer words longer
    const dur = Math.min(0.6, Math.max(0.14, 0.055 * [...tok].length + (r() - 0.5) * 0.08));
    hi.push({ text: tok, start: round(t), end: round(t + dur) });
    t += dur;
    if (i < toks.length - 1) t += draw(inside);
  });
  truth.push({ start: round(start), end: round(t) });
  if (si < SENTENCES.length - 1) t += draw(between);
});
await write("hindi-unpunctuated", {
  note: "Synthetic Hindi without punctuation: original text; gaps drawn from hormozi-unpunctuated's real gaps (inside a sentence from those inside, between sentences from those between). `sentences` is the ground truth. Regenerate with src/eval/tools/synth-unpunctuated.ts.",
  title: "पुरानी दिल्ली का खाना (synthetic, unpunctuated)",
  language: "hi",
  durationSec: round(t + 1),
  segments: toSentences(hi, undefined, "hi"),
  words: hi,
  sentences: truth,
});
