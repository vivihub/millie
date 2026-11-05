/**
 * Read-only editor preflight. Run preflightMillieV10() in the GAS editor.
 * This function is not connected to doGet/doPost, and never logs credentials,
 * provider response bodies, arbitrary account IDs, or exception messages.
 */
function preflightMillieV10() {
  var expectedBasicId = '@575kepfk';
  var requiredNames = [
    'SPREADSHEET_ID', 'CHANNEL_ACCESS_TOKEN', 'MILLIE_GATEWAY_SECRET',
    'MILLIE_AI_ENABLED', 'GEMINI_API_KEY', 'GEMINI_MODEL'
  ];
  var report = {
    ready: false,
    configuration: { ok: false, required: {}, aiEnabled: false, modelIdValid: false },
    schema: { checked: false, ok: false },
    line: { checked: false, ok: false, httpStatus: null, basicId: null },
    gemini: { checked: false, ok: false, httpStatus: null, modelId: null, generateContent: false }
  };
  var values = {};
  var properties = null;
  requiredNames.forEach(function (name) { report.configuration.required[name] = false; });
  try { properties = PropertiesService.getScriptProperties(); } catch (_) {}
  requiredNames.forEach(function (name) {
    var value = null;
    try { if (properties) value = properties.getProperty(name); } catch (_) {}
    if (typeof value === 'string' && value.trim()) {
      values[name] = value;
      report.configuration.required[name] = true;
    }
  });
  report.configuration.ok = requiredNames.every(function (name) { return report.configuration.required[name]; });
  report.configuration.aiEnabled = values.MILLIE_AI_ENABLED === 'true';
  report.configuration.modelIdValid = typeof values.GEMINI_MODEL === 'string' && /^[A-Za-z0-9_.-]+$/.test(values.GEMINI_MODEL);

  if (report.configuration.required.SPREADSHEET_ID) {
    report.schema.checked = true;
    try {
      var schema = previewMigration();
      report.schema.ok = !!schema && schema.ok === true;
    } catch (_) {}
  }

  if (report.configuration.required.CHANNEL_ACCESS_TOKEN) {
    report.line.checked = true;
    try {
      var lineResponse = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
        method: 'get',
        headers: { Authorization: 'Bearer ' + values.CHANNEL_ACCESS_TOKEN },
        muteHttpExceptions: true,
        followRedirects: false
      });
      report.line.httpStatus = safeMilliePreflightStatus_(lineResponse);
      if (report.line.httpStatus === 200) {
        var bot = JSON.parse(lineResponse.getContentText());
        if (bot && bot.basicId === expectedBasicId) {
          report.line.basicId = expectedBasicId;
          report.line.ok = true;
        }
      }
    } catch (_) {}
  }

  if (report.configuration.required.GEMINI_API_KEY && report.configuration.modelIdValid) {
    report.gemini.checked = true;
    try {
      var model = values.GEMINI_MODEL;
      var geminiResponse = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model, {
        method: 'get',
        headers: { 'x-goog-api-key': values.GEMINI_API_KEY },
        muteHttpExceptions: true,
        followRedirects: false
      });
      report.gemini.httpStatus = safeMilliePreflightStatus_(geminiResponse);
      if (report.gemini.httpStatus === 200) {
        var metadata = JSON.parse(geminiResponse.getContentText());
        if (metadata && metadata.name === 'models/' + model) {
          // Only emit the confirmed model ID, never an arbitrary API field.
          // A credential pasted into the model field must also stay private.
          var isCredential = ['CHANNEL_ACCESS_TOKEN', 'MILLIE_GATEWAY_SECRET', 'GEMINI_API_KEY', 'SPREADSHEET_ID']
            .some(function (name) { return model === values[name]; });
          if (!isCredential) report.gemini.modelId = model;
          report.gemini.generateContent = Array.isArray(metadata.supportedGenerationMethods) &&
            metadata.supportedGenerationMethods.indexOf('generateContent') >= 0;
          report.gemini.ok = !isCredential && report.gemini.generateContent;
        }
      }
    } catch (_) {}
  }

  report.ready = report.configuration.ok && report.configuration.aiEnabled && report.configuration.modelIdValid &&
    report.schema.ok && report.line.ok && report.gemini.ok;
  // The editor's execution log shows only this same allowlisted report.
  // Logging failures must not prevent the caller from receiving diagnostics.
  try { Logger.log(JSON.stringify(report)); } catch (_) {}
  return report;
}

function safeMilliePreflightStatus_(response) {
  var status = response.getResponseCode();
  return typeof status === 'number' && isFinite(status) && Math.floor(status) === status && status >= 100 && status <= 599 ? status : null;
}
