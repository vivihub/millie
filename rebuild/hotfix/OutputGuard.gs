/**
 * UNAPPLIED PATCH CANDIDATE for the legacy callGemini() response extraction.
 * The complete legacy source and its caller's null handling are unverified.
 * Review both before applying or deploying. This file performs no I/O or writes.
 *
 * Intended replacement for the observed candidate/text extraction only:
 *   return millieExtractDialogue_(data.candidates && data.candidates[0]);
 * Keep the existing request, configuration, state handling, and error handling.
 */
function millieExtractDialogue_(candidate) {
  if (!candidate || typeof candidate !== 'object' || candidate.finishReason === 'SAFETY') return null;
  var parts = candidate.content && candidate.content.parts;
  if (!Array.isArray(parts)) return null;

  var text = parts.filter(function (part) {
    // Gemini's structured flag is named "thought", not "think".
    return part && typeof part === 'object' && part.thought !== true && typeof part.text === 'string';
  }).map(function (part) { return part.text; }).join('').trim();

  if (!text || millieHasMetaOutput_(text) || millieClaimsWindowSurveillance_(text)) return null;
  return text;
}

function millieHasMetaOutput_(text) {
  var marker = /\b(?:THOUGHTS?|THINKING|ANALYSIS|REASONING|CHAIN[ -]OF[ -]THOUGHT)\s*(?:\*{1,2}|_{1,2})?\s*[:：]/i;
  var heading = /(?:^|[\r\n])\s*(?:#{1,6}\s*)?(?:\*{1,2}|_{1,2})?(?:THOUGHTS?|THINKING|ANALYSIS|REASONING)(?:\*{1,2}|_{1,2})?\s*(?:[\r\n]|$)/i;
  return marker.test(text) || heading.test(text) ||
    /<\/?(?:think|thinking|analysis|reasoning)\b[^>]*>/i.test(text) ||
    /\bthe user responded\b/i.test(text) ||
    /\bnow i (?:need|have) to (?:answer|respond)\b/i.test(text);
}

function millieClaimsWindowSurveillance_(text) {
  // These are narrow output checks, not a claim that every possible paraphrase
  // can be identified. Ordinary window descriptions and explicit denials pass.
  // Normalize only the comparison text; never rewrite returned dialogue.
  var sentences = text.replace(/まど/g, '窓').replace(/お?へや/g, '部屋').split(/[。.!?！？\r\n]+/);
  var denialAfter = '(?!\\s*(?:わけ(?:じゃ|では)ない|のではない|んじゃない|ことはない|はずがない))';
  var watching = '(?:見て(?:いる|る)|のぞいて(?:いる|る)|覗いて(?:いる|る)|監視して(?:いる|る))' + denialAfter;
  var visible = '(?:見える|見えている)' + denialAfter;
  var target = '(?:あなた|君|きみ|おまえ|そっち)(?:の(?:部屋|家)(?:の中)?|の姿)?';
  var adverbs = '[、,\\s]*(?:(?:ずっと|今も|いまも|ちゃんと|いつも|そっと|こっそり|今|いま)[、,\\s]*){0,3}';
  var directJapanese = new RegExp('窓[^。.!?！？\\r\\n]{0,60}' + target + '(?:を|が)' + adverbs + '(?:' + watching + '|' + visible + ')');
  var implicitJapanese = new RegExp('窓(?:の外|の向こう|越し)?(?:から|で|に)?' + adverbs + watching);
  var outsideJapanese = new RegExp('(?:あなた|君|きみ)の(?:部屋の)?窓の外[^。.!?！？\\r\\n]{0,12}にいる' + denialAfter);
  // Also reject a short location-only assertion, e.g. "部屋の窓からだよ🌙".
  // A following object/action such as "窓から外を見ている" does not match.
  var windowFragment = /窓(?:の外|越し)?から[、,\s（(]*(?:だよ|です|だね|なの|ね)?[\s、,…）)〜～\u2600-\u27BF\uFE0F\u200D\uD800-\uDFFF]*$/;

  return sentences.some(function (sentence) {
    if (!/(?:窓|\bwindows?\b)/i.test(sentence)) return false;
    // Keep third-person stories explicitly presented as fiction or hearsay.
    if (/(?:という|っていう)(?:お話|話|怪談|物語|うわさ|噂)|と(?:言|い)われて|\b(?:in (?:this|the) story|in the (?:movie|film)|once upon a time)\b/i.test(sentence)) return false;
    if (windowFragment.test(sentence) || directJapanese.test(sentence) || implicitJapanese.test(sentence) || outsideJapanese.test(sentence)) return true;

    var englishWatching = /\bi(?:['’]m| am|['’]ve been| have been)\s+(?:watching|observing|spying on)\s+(?:you|your (?:room|home|house))\b/i;
    var englishSeeing = /\bi\s+(?:can\s+)?(?:see|watch)\s+(?:you|(?:inside\s+)?your (?:room|home|house))\b/i;
    var englishOutside = /\bi(?:['’]m| am)\s+(?:standing\s+)?(?:outside|at|by|behind)\s+your window\b/i;
    return englishWatching.test(sentence) || englishSeeing.test(sentence) || englishOutside.test(sentence);
  });
}
