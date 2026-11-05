/** Optional Gemini natural conversation. Story milestones always stay deterministic. */
var MillieAI = (function () {
  function quotedExplanationCopy(text) {
    // This copy is used only for inspection. The original text is either
    // accepted intact or the entire candidate is replaced by Core's fallback.
    return text.replace(/["「『“][^"「」『』“”\n]{1,100}["」』”](?=\s*(?:は[、,\s]*(?:「|『|"|“|英語|日本語|物語|フィクション|架空|内部|分析|思考|記述|表現|意味|応答|タグ)|という(?:意味|表現|言葉|ことば|文|せりふ|台詞)))/g, 'quoted explanation');
  }

  function hasMetaText(message) {
    var text = quotedExplanationCopy(message.replace(/\r\n?/g, '\n').replace(/[\u200b-\u200d\ufeff]/g, ''));
    text = text.replace(/(^|\n)([ \t]*)(?:[-*+•–—]|\d+[.)])[ \t]+/g, '$1$2');
    // Inspect a separate copy. Quoting an isolated marker while explaining it
    // is ordinary conversation; no part of a rejected answer is ever stripped
    // and sent to LINE.
    text = text.replace(/["'「『“‘`]\s*(?:thoughts?|analysis|internal\s+reasoning|ユーザ[ーｰ]?(?:の)?分析|思考過程)\s*[:：]\s*["'」』”’`]/gi, 'quoted marker');
    text = text.replace(/["'「『“‘`]\s*<\s*\/?\s*(?:think|thinking|analysis|reasoning)\s*>\s*["'」』”’`]/gi, 'quoted tag');
    if (/<\s*\/?\s*(?:think|thinking|analysis|reasoning|internal[_-]?(?:reasoning|thoughts?|analysis))\b[^>]*>/i.test(text) || /<\|(?:analysis|thinking|thoughts?|reasoning)\|>/i.test(text)) return true;
    if (/\b(?:the user responded with|now I need to answer)\b/i.test(text)) return true;
    if (/(?:^|\n)\s*(?:>\s*)?(?:#{1,6}\s*)?(?:["'「『“‘`]\s*)?(?:\*\*|__)?\s*(?:thoughts?|analysis|reasoning|internal\s+(?:reasoning|analysis|thoughts?)|chain[\s-]+of[\s-]+thought|思考(?:過程|プロセス)?|内部(?:推論|思考|分析)|ユーザ[ーｰ]?(?:の)?(?:分析|意図|発言分析|意図分析|感情分析)|応答(?:の)?(?:方針|計画)|返答(?:の)?方針)\s*(?:\*\*|__)?\s*(?:[:：]|\n|$)/i.test(text)) return true;
    return /(?:^|\n)\s*(?:【(?:THOUGHTS?|ANALYSIS|INTERNAL REASONING|内部推論|内部思考|思考過程|ユーザ[ーｰ]?(?:の)?分析|応答方針|返答方針)】|\[(?:analysis|thoughts?|internal reasoning)\])/i.test(text);
  }

  function claimsLiveSurveillance(message) {
    var text = quotedExplanationCopy(message);
    // The reported fragment is a physical-presence claim in reply to
    // "where from?", even without an explicit verb such as "watching".
    if (/^[\s.…]*(?:(?:あなた|きみ|君)の)?(?:おへや|お部屋|部屋)(?:の)?(?:まど|窓)(?:の外)?から(?:だよ|です)?[。.!！…\s\u2600-\u27bf\ufe0e\ufe0f\u200d\ud800-\udfff]*$/.test(text)) return true;
    if (/(?:おへや|お部屋|部屋|自宅|いえ|家)(?:の)?(?:窓|まど)(?:の外)?から[^。！？\n]{0,24}(?:見て(?:る|いる|います|た|いた)|みて(?:る|いる|た|いた)|のぞいて(?:る|いる|た|いた)|覗いて(?:る|いる|た|いた))(?!わけ(?:では|じゃ)ない|のではない|んじゃない)/.test(text)) return true;
    return /\b(?:I(?:'m| am)|we(?:'re| are))\s+(?:watching|looking at|spying on)\s+you\b/i.test(text) || /\bI can see you (?:through|from) (?:your |the )?(?:bedroom |room )?window\b/i.test(text);
  }

  function historyWithoutMetaAssistant(value) {
    var entries;
    try { entries = Array.isArray(value) ? value : JSON.parse(value || '[]'); } catch (_) { entries = []; }
    if (!Array.isArray(entries)) return [];
    // User quotations are input, not leaked model output. Retain every user
    // record and remove only known meta text attributed to an assistant/model.
    return entries.filter(function (entry) {
      if (!entry || !/^(assistant|model)$/.test(entry.role)) return true;
      // Legacy GAS stored dialogue in text; v10 stores it in content. Inspect
      // both when a record has both fields, before Core normalizes the shape.
      return ![entry.content, entry.text].some(function (text) {
        return typeof text === 'string' && hasMetaText(text);
      });
    });
  }

  function enhance(before, input, result, ctx) {
    if (!result.aiEligible || result.shareCard) return result;
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('MILLIE_AI_ENABLED') !== 'true') return result;
    var model = props.getProperty('GEMINI_MODEL') || '';
    var key = props.getProperty('GEMINI_API_KEY');
    if (!key || !/^[A-Za-z0-9_.-]+$/.test(model)) return result;
    try {
      var promptUser = JSON.parse(JSON.stringify(result.user));
      promptUser.history = JSON.stringify(historyWithoutMetaAssistant(before.history));
      var payload = MillieCore.buildPrompt(promptUser, input);
      payload.systemInstruction.parts.push({text:'出力はJSONのみ。形式は{"messages":["短い返答"]}。1〜3件、各100文字以内。普通の質問には内容に合った答えを返す。現在地やカメラや他人とのLINEは取得していない。部屋の窓など現実の場所から見ていると言わない。知らない事実を作らない。現在の段階を飛び越えた怪談・紹介要求・結末は出さない。URL・管理者向け情報・APIや内部設定の説明を通常会話に混ぜない。思考過程、ユーザー分析、応答方針、THOUGHTSやANALYSISなどのメモ見出し、thinkタグはmessagesへ含めない。'});
      payload.generationConfig = {temperature:0.65,maxOutputTokens:400,responseMimeType:'application/json'};
      if (/^gemini-2\.5-flash(?:-|$)/.test(model)) {
        payload.generationConfig.thinkingConfig = {thinkingBudget:0,includeThoughts:false};
      }
      var response = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method:'post',contentType:'application/json',headers:{'x-goog-api-key':key},payload:JSON.stringify(payload),muteHttpExceptions:true
      });
      if (response.getResponseCode() !== 200) return result;
      var data = JSON.parse(response.getContentText());
      var candidate = data.candidates && data.candidates[0];
      if (!candidate || candidate.finishReason && candidate.finishReason !== 'STOP') return result;
      var parts = candidate.content && candidate.content.parts || [];
      // Gemini marks structured thought parts in API metadata. They are not
      // answer text. Separately validate the generated messages below because
      // ordinary text parts can themselves contain unwanted meta commentary.
      var output = parts.filter(function(p){return typeof p.text==='string' && !p.thought;}).map(function(p){return p.text;}).join('');
      var messages = JSON.parse(output).messages;
      if (!Array.isArray(messages) || messages.length<1 || messages.length>3) return result;
      if (messages.some(function(m){return typeof m!=='string' || !m.trim() || m.length>100 || /https?:|```|APIキー|CHANNEL_ACCESS_TOKEN|GEMINI_API_KEY|位置情報を取得|カメラで見|ブロックしても届|[３3]人に紹介|実際に監視/.test(m);})) return result;
      // Reject the entire candidate. Never salvage a suffix after a reasoning
      // heading or retain the other bubbles of a contaminated response.
      if (messages.some(function(m){return hasMetaText(m) || claimsLiveSurveillance(m);})) return result;
      messages = messages.map(function(m){return m.trim();});
      var changed = JSON.parse(JSON.stringify(result));
      changed.messages = messages;
      var history;
      try { history=JSON.parse(changed.user.history || '[]'); } catch(e){history=[];}
      if (Array.isArray(history)) {
        // Remove every fallback bubble from this turn, not the previous model turn.
        for(var i=0;i<result.messages.length && history.length && /^(assistant|model)$/.test(history[history.length-1].role);i++) history.pop();
        history = historyWithoutMetaAssistant(history);
        messages.forEach(function(message){history.push({role:'assistant',content:message});});
        history=history.slice(-12);
        while(history.length && Utilities.newBlob(JSON.stringify(history)).getBytes().length>2400) history.shift();
        changed.user.history=JSON.stringify(history);
      }
      return changed;
    } catch (ignored) {
      // Provider payloads and user text are never written to logs.
      return result;
    }
  }
  return {enhance:enhance};
})();
