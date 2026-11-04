/** Optional Gemini natural conversation. Story milestones always stay deterministic. */
var MillieAI = (function () {
  function enhance(before, input, result, ctx) {
    if (!result.aiEligible || result.shareCard) return result;
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('MILLIE_AI_ENABLED') !== 'true') return result;
    var model = props.getProperty('GEMINI_MODEL') || '';
    var key = props.getProperty('GEMINI_API_KEY');
    if (!key || !/^[A-Za-z0-9_.-]+$/.test(model)) return result;
    try {
      var promptUser = JSON.parse(JSON.stringify(result.user));
      promptUser.history = before.history || '[]';
      var payload = MillieCore.buildPrompt(promptUser, input);
      payload.systemInstruction.parts.push({text:'出力はJSONのみ。形式は{"messages":["短い返答"]}。1〜3件、各100文字以内。普通の質問には内容に合った答えを返す。現在地やカメラや他人とのLINEは取得していない。知らない事実を作らない。現在の段階を飛び越えた怪談・紹介要求・結末は出さない。URL・管理者向け情報・APIや内部設定の説明を通常会話に混ぜない。'});
      payload.generationConfig = {temperature:0.65,maxOutputTokens:400,responseMimeType:'application/json'};
      var response = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
        method:'post',contentType:'application/json',headers:{'x-goog-api-key':key},payload:JSON.stringify(payload),muteHttpExceptions:true
      });
      if (response.getResponseCode() !== 200) return result;
      var data = JSON.parse(response.getContentText());
      var candidate = data.candidates && data.candidates[0];
      if (!candidate || candidate.finishReason && candidate.finishReason !== 'STOP') return result;
      var parts = candidate.content && candidate.content.parts || [];
      var output = parts.filter(function(p){return typeof p.text==='string' && !p.thought;}).map(function(p){return p.text;}).join('');
      var messages = JSON.parse(output).messages;
      if (!Array.isArray(messages) || messages.length<1 || messages.length>3) return result;
      if (messages.some(function(m){return typeof m!=='string' || !m.trim() || m.length>100 || /https?:|```|APIキー|CHANNEL_ACCESS_TOKEN|GEMINI_API_KEY|位置情報を取得|カメラで見|ブロックしても届|[３3]人に紹介|実際に監視/.test(m);})) return result;
      messages = messages.map(function(m){return m.trim();});
      var changed = JSON.parse(JSON.stringify(result));
      changed.messages = messages;
      var history;
      try { history=JSON.parse(changed.user.history || '[]'); } catch(e){history=[];}
      if (Array.isArray(history)) {
        // Remove every fallback bubble from this turn, not the previous model turn.
        for(var i=0;i<result.messages.length && history.length && /^(assistant|model)$/.test(history[history.length-1].role);i++) history.pop();
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
