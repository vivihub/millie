#!/usr/bin/env python3
"""Build the offline Millie conversation review from the shared Apps Script core.

Run: python3 /workspace/millie/rebuild/demo/build.py
Both HTML files contain the same core and assets and can be opened directly.
No credentials, network calls, or production LINE connection are included.
"""

from __future__ import annotations

import base64
import pathlib
import re


HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
CORE = ROOT / "apps-script" / "Core.gs"
ICON = ROOT.parent / "icon.png"


TEMPLATE = r'''<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="description" content="ミリーちゃんの作品に沿ったLINE会話体験の確認用サンプル。">
<title>ミリーちゃん｜会話体験サンプル</title>
<style>
:root{--ink:#302538;--muted:#7e6c79;--paper:#f9f3f0;--line:#e6dadd;--accent:#78526e;--pink:#f5dce0;--purple:#34283e;--shadow:0 24px 80px #3a22321c;--chat:#f5eeec;--bubble:#fffdfa;--mine:#e5d6e2;--radius:26px;font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",Meiryo,sans-serif;font-synthesis:none;color:var(--ink);background:var(--paper)}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 15% 0%,#f1d7df85,transparent 55%),radial-gradient(ellipse at 100% 100%,#d8ccd850,transparent 50%),var(--paper);min-height:100svh}button,input,select,textarea{font:inherit}button,a,textarea,select{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:wait;opacity:.48}button:focus-visible,a:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #996888;outline-offset:4px}a{color:inherit;text-underline-offset:4px}button{color:inherit}button:active:not(:disabled){transform:translateY(1px)}[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.app{max-width:1100px;min-height:100svh;margin:0 auto;padding:28px 40px 24px}.masthead{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:24px}.wordmark{font-family:Georgia,"Yu Mincho",serif;font-size:19px;font-weight:400;letter-spacing:.16em}.edition{font-size:10px;letter-spacing:.12em;color:var(--muted)}.masthead a{font-size:11px;color:var(--muted);text-decoration:none;border-bottom:1px solid var(--line);padding:5px 0}.layout{display:grid;grid-template-columns:minmax(260px,1fr) minmax(340px,460px);gap:68px;align-items:start}.side{padding:18px 0 0}.eyebrow{display:flex;align-items:center;gap:10px;color:var(--accent);font-size:10px;letter-spacing:.15em}.eyebrow:before{content:"";display:inline-block;width:28px;height:1px;background:currentColor}.intro h1{font-family:"Yu Mincho","Hiragino Mincho ProN",serif;font-weight:500;font-size:38px;line-height:1.75;letter-spacing:.13em;margin:23px 0 17px}.intro h1 span{color:#9a657b}.intro p{font-size:12px;line-height:2.1;color:var(--muted);max-width:330px;margin:0}.intro .new-scene-note{font-size:10px;margin-top:17px;color:#8c7583}.link-row{display:flex;gap:22px;margin:23px 0 32px;font-size:11px}.link-row a{display:flex;align-items:center;gap:7px}.external-arrow{font-size:13px;color:var(--accent)}.mini-rule{height:1px;background:linear-gradient(90deg,var(--line),transparent);margin:0 0 24px}
.phone{height:min(810px,calc(100svh - 110px));min-height:610px;background:var(--chat);border:1px solid #dfd1da;border-radius:30px;box-shadow:var(--shadow);overflow:hidden;display:flex;flex-direction:column;position:relative;transition:background .6s,border-color .6s}.phone:before{content:"";position:absolute;inset:0;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 140 140' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' opacity='.025' filter='url(%23n)'/%3E%3C/svg%3E");z-index:0}.phone>*{position:relative}.chat-head{display:flex;gap:11px;align-items:center;padding:18px 20px 15px;background:#fffaf7ed;border-bottom:1px solid #e6daddb0;z-index:1}.avatar{width:40px;height:40px;flex:0 0 auto;position:relative;overflow:hidden;border-radius:50%;background:#e8d6e0;border:1px solid #dcc7d4}.avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:52% 23%;transform:scale(1.7);transform-origin:52% 30%}.avatar-fallback{display:grid;place-items:center;height:100%;font-family:serif;color:#6c4462}.chat-name{font-size:15px;font-weight:600;letter-spacing:.08em}.chat-subtitle{font-size:10px;color:var(--muted);margin-top:5px;letter-spacing:.04em}.head-label{margin-left:auto;align-self:flex-start;font-size:9px;letter-spacing:.04em;padding:5px 7px;border:1px solid var(--line);border-radius:20px;color:var(--muted);white-space:nowrap}.chat-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:0 18px 22px;scrollbar-width:thin;scrollbar-color:#ccb7c6 transparent}.date-divider{text-align:center;font-size:10px;color:#9d8794;padding:20px 0 24px;letter-spacing:.09em}.chat-log{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:17px}.message{display:flex;gap:8px;align-items:flex-start;animation:appear .22s ease-out}.message.bot{margin-right:22px}.message.user{flex-direction:row-reverse;margin-left:40px}.message .avatar{width:24px;height:24px;margin-top:1px;border:0}.bubble-wrap{min-width:0;max-width:calc(100% - 32px)}.bubble{background:var(--bubble);border:1px solid #ebe0e3;border-radius:2px 15px 15px 15px;padding:12px 14px;font-size:12px;line-height:1.9;letter-spacing:.02em;overflow-wrap:anywhere;white-space:pre-wrap;box-shadow:0 2px 5px #2d182805;transition:background .6s,color .6s,border-color .6s}.message.user .bubble{background:var(--mine);border-color:#d7c3d2;border-radius:15px 2px 15px 15px}.message.user .bubble-wrap{max-width:100%}.message-time{font-size:8px;color:#9a8391;margin-top:4px;letter-spacing:.04em;text-align:right}.message.bot .message-time{text-align:left;padding-left:2px}.system-line{text-align:center;font-size:10px;line-height:1.9;color:var(--muted);padding:6px 10px}.typing{display:flex;align-items:center;gap:4px;height:22px;min-width:35px}.typing span{width:4px;height:4px;border-radius:50%;background:#ab8c9f;animation:pulse 1s infinite}.typing span:nth-child(2){animation-delay:.15s}.typing span:nth-child(3){animation-delay:.3s}.starters{margin:25px 0 0 32px}.starters-title{font-size:9px;color:var(--muted);margin-bottom:8px}.starter{display:block;text-align:left;border:1px solid #d7c2cf;background:#fffcfa80;border-radius:16px;font-size:10px;line-height:1.7;padding:7px 11px;margin:7px 0;transition:background .2s}.starter:hover{background:#fffaf9}.chat-bottom{background:#fffaf7f2;border-top:1px solid #e6daddb0;padding:12px 15px 10px}.quick-actions{display:flex;gap:6px;align-items:center;margin-bottom:10px;flex-wrap:wrap}.chip{background:transparent;border:1px solid #d9c7d3;border-radius:20px;padding:6px 10px;font-size:10px;line-height:1.4;white-space:nowrap}.chip:hover{background:#f5e8ee}.stop{margin-left:auto;border:0;padding-right:2px;color:var(--muted);text-decoration:underline;text-underline-offset:3px;font-size:9px}.composer{display:flex;align-items:flex-end;gap:8px}.input-wrap{flex:1;min-width:0;border:1px solid #deced8;border-radius:18px;background:#fffefd;display:flex;align-items:center}.composer textarea{border:0;resize:none;outline-offset:1px;background:transparent;width:100%;padding:11px 13px;color:#3c2a3a;font-size:12px;line-height:1.6;max-height:94px;min-height:42px;display:block;overflow:auto}.composer textarea::placeholder{color:#ac96a4;font-size:11px}.send{display:grid;place-items:center;width:41px;height:41px;border:0;border-radius:50%;background:#715268;color:#fff7fc;flex:0 0 auto;margin-bottom:1px}.send svg{width:17px;height:17px}.privacy-note{font-size:8px;text-align:center;color:#a28c9a;margin-top:8px;letter-spacing:.02em}.composer-message{font-size:10px;color:#875068;margin:7px 0 0;min-height:0}.composer-message:empty{display:none}
.review{font-size:11px;color:#74616f}.review>summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;padding:2px 0 13px;letter-spacing:.1em;font-size:11px}.review>summary::-webkit-details-marker{display:none}.review>summary:after{content:"−";font-size:16px;color:#9a8091}.review:not([open])>summary:after{content:"＋"}.review-content{padding-top:2px}.review-tag{display:inline-block;background:#ebdfe7;color:#75596b;border-radius:4px;font-size:9px;padding:4px 6px;letter-spacing:.03em}.review-note{font-size:10px;line-height:1.9;margin:11px 0 17px;color:#8b7582}.stats{display:flex;gap:22px;margin:17px 0 19px}.stat-label{font-size:9px;color:#957d8c;margin-bottom:5px}.stat-value{font-family:Georgia,"Yu Mincho",serif;font-size:25px;color:#5a3b52;font-variant-numeric:tabular-nums;letter-spacing:.02em}.stat-value small{font-size:11px;font-family:inherit;color:#9e8795;margin-left:2px}.phase-text{font-size:11px;color:#846777;margin-top:0;min-height:1.5em}.phase-grid{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:4px;margin:11px 0}.phase-button{border:1px solid #dbc9d4;background:#f9f2f4;border-radius:6px;min-width:0;height:30px;padding:0;font-size:10px;color:#927386}.phase-button[aria-pressed="true"]{background:#75556c;color:#fffafc;border-color:#75556c}.preview-row{display:flex;justify-content:space-between;align-items:center;margin:15px 0;gap:12px}.preview-row label{font-size:10px;color:#846e7c}.preview-row select{border:1px solid #d8c4d1;padding:7px 24px 7px 9px;border-radius:7px;background:#fcf6f5;color:#6c5063;font-size:10px;max-width:160px}.review-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.outline-button{border:1px solid #d3bccb;background:transparent;font-size:10px;padding:8px 12px;border-radius:7px;line-height:1.5}.outline-button:hover{background:#eee1e8}.review-footnote{font-size:9px;line-height:1.9;color:#9b8292;margin:13px 0 0}.review-live{font-size:10px;min-height:1.8em;color:#7e556f;margin:11px 0 0}.share-section{margin-top:24px;border-top:1px solid var(--line);padding-top:21px}.share-kicker{font-size:9px;letter-spacing:.12em;color:#a07d92;margin:0 0 8px}.share-heading{font-family:"Yu Mincho",serif;font-weight:500;letter-spacing:.08em;font-size:17px;margin:0 0 11px}.share-description{color:#8b7582;font-size:10px;line-height:1.9;margin:0 0 13px}.share-preview{display:block;width:100%;height:auto;aspect-ratio:4/5;border-radius:10px;border:1px solid #cbb8c8;background:#261d32}.share-buttons{display:flex;flex-wrap:wrap;gap:7px;margin-top:12px}.share-buttons .primary-button{background:#72516a;color:#fff6fc;border-color:#72516a}.share-status{font-size:10px;line-height:1.8;color:#8e6a81;min-height:1.8em;margin:9px 0 0}.mobile-note{display:none}.footer-note{font-size:9px;line-height:1.8;color:#ab93a2;margin-top:26px;max-width:320px}
body[data-phase="5"],body[data-phase="6"],body[data-phase="7"]{--chat:#ece3ed;--bubble:#fffbfc;--mine:#ded0e3}.phone.night{--chat:#251e30;--bubble:#3c3148;--mine:#66526c;border-color:#4a3a52}.phone.night .chat-scroll{scrollbar-color:#5b4762 transparent}.phone.night .bubble{border-color:#504057;color:#eee4ee}.phone.night .message.user .bubble{border-color:#715c78}.phone.night .message-time,.phone.night .date-divider{color:#9c86a7}.phone.night .system-line{color:#ac91b5}.phone.night .starter{background:#3a2e45;border-color:#66506c;color:#dbc8e3}.phone.night .starters-title{color:#b398bd}.phone.night .chat-head,.phone.night .chat-bottom{background:#302539f5;border-color:#53415d;color:#eee2ec}.phone.night .chat-subtitle,.phone.night .head-label,.phone.night .privacy-note{color:#b19bb7}.phone.night .head-label{border-color:#624c69}.phone.night .chip{border-color:#67526f;color:#d4bfdc}.phone.night .chip:hover{background:#483651}.phone.night .stop{color:#b7a0bc}.phone.night .input-wrap{background:#3e3048;border-color:#624e6a}.phone.night textarea{color:#f0e5f4}.phone.night textarea::placeholder{color:#ac93b4}.phone.night .send{background:#b393b2;color:#2b2034}.phone.night .composer-message{color:#d5b6cd}
.copy-fallback{margin-top:10px}.copy-fallback label{display:block;font-size:10px;margin-bottom:6px;color:#8b7582}.copy-fallback textarea{display:block;width:100%;min-height:150px;resize:vertical;border:1px solid #d5c0ce;border-radius:7px;background:#fffaf8;padding:10px;color:#6b5062;font-size:11px;line-height:1.8}
@keyframes appear{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,70%,100%{opacity:.3;transform:translateY(0)}35%{opacity:1;transform:translateY(-2px)}}
@media(min-width:1600px){.app{padding-top:48px}.masthead{margin-bottom:35px}.phone{height:810px}}
@media(max-width:880px){.app{padding:22px 24px}.layout{gap:30px;grid-template-columns:minmax(240px,1fr) minmax(330px,440px)}.intro h1{font-size:31px}.phone{height:calc(100svh - 100px);min-height:590px}.intro p{font-size:11px}.link-row{gap:14px}.side{padding-top:13px}}
@media(max-width:700px){body{background:#f4ecef}.app{padding:0;min-height:100svh;max-width:none}.masthead{display:none}.layout{display:flex;flex-direction:column;gap:0;align-items:stretch}.phone{order:0;width:100%;max-width:none;height:100svh;min-height:0;border-radius:0;border:0;box-shadow:none}.chat-head{padding:calc(13px + env(safe-area-inset-top)) 17px 13px}.chat-bottom{padding:11px 13px calc(9px + env(safe-area-inset-bottom))}.chat-scroll{padding:0 15px 20px}.date-divider{padding:18px 0 23px}.message .bubble{font-size:13px}.message.bot{margin-right:18px}.message.user{margin-left:46px}.chat-name{font-size:15px}.head-label{margin-top:2px}.side{order:1;padding:26px 24px 32px}.intro{display:none}.mini-rule{display:none}.review{max-width:460px;margin:auto}.review>summary{font-size:12px}.review-content{padding-top:10px}.review-note{max-width:390px}.footer-note{max-width:460px;margin:22px auto 0}.mobile-note{display:block;padding:22px 22px 0;font-size:10px;color:#9b8292;line-height:1.8;text-align:center;order:1}.share-section{max-width:460px;margin:25px auto 0}.share-preview{max-width:320px;margin:auto}.share-buttons{justify-content:center}.share-heading,.share-description,.share-kicker{text-align:center}.share-status{text-align:center}.composer textarea{font-size:16px;padding:10px 12px;line-height:1.45;min-height:43px}.starter{font-size:11px}.chip{font-size:11px}.stop{font-size:10px}.privacy-note{font-size:9px}.phone .chat-subtitle{font-size:10px}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
</style>
</head>
<body data-phase="1">
<div class="app">
  <header class="masthead">
    <div class="wordmark">Millie <span class="edition">／ ミリーちゃん</span></div>
    <a href="https://youtu.be/4jJUsXAld6Y" target="_blank" rel="noopener noreferrer">原作を観る <span aria-hidden="true">↗</span></a>
  </header>
  <main class="layout">
    <aside class="side" aria-label="サンプルのご案内">
      <div class="intro">
        <div class="eyebrow">ミリーちゃんの会話体験</div>
        <h1>ねえ、<br>そのつづき、<br><span>聞かせて。</span></h1>
        <p>だれにも言えないことも、<br>うまく言えない気持ちも。<br>ミリーちゃんは、あなたの話を待っている。</p>
        <p class="new-scene-note">原作の人物像をもとにした、新しい会話演出のサンプルです。</p>
        <div class="link-row">
          <a href="https://youtu.be/4jJUsXAld6Y" target="_blank" rel="noopener noreferrer">原作動画 <span class="external-arrow" aria-hidden="true">↗</span></a>
          <a href="https://line.me/R/ti/p/@575kepfk" target="_blank" rel="noopener noreferrer">公式LINE <span class="external-arrow" aria-hidden="true">↗</span></a>
        </div>
      </div>
      <div class="mini-rule"></div>
      <details class="review" open>
        <summary>制作確認</summary>
        <div class="review-content">
          <span class="review-tag">本番LINEには接続していません</span>
          <p class="review-note">決められた会話分岐を確認するサンプルです。<br>AIへの接続・実際のメッセージ送信は行いません。</p>
          <div class="stats">
            <div><div class="stat-label">会話の進行</div><div class="stat-value"><span id="phase-value">01</span><small>/ 10</small></div></div>
            <div><div class="stat-label">やりとり</div><div class="stat-value"><span id="count-value">0</span><small>回</small></div></div>
          </div>
          <p class="phase-text" id="phase-label">いつものミリーちゃん</p>
          <div class="phase-grid" role="group" aria-label="会話の段階をプレビュー" id="phase-grid"></div>
          <div class="preview-row"><label for="time-preview">時刻のプレビュー</label><select id="time-preview"><option value="now">いまの時刻</option><option value="02:17">午前 2:17</option><option value="03:33">午前 3:33</option><option value="04:44">午前 4:44</option></select></div>
          <div class="review-buttons"><button class="outline-button" type="button" id="reset">最初から試す</button><button class="outline-button" type="button" id="share-preview">共有カードを見る</button></div>
          <p class="review-footnote">数字を選ぶと、次の通常メッセージからその段階を試せます。占い・怪談・停止・共有では進行回数は増えません。</p>
          <p class="review-footnote">会話の分岐・結末・共有カードは追加演出案です。画像は既存素材の仮表示です。</p>
          <p id="review-status" class="review-live" role="status" aria-live="polite"></p>
        </div>
      </details>
      <section class="share-section" id="share-section" aria-labelledby="share-heading" hidden>
        <p class="share-kicker">MILLIE / YOUR STORY</p>
        <h2 class="share-heading" id="share-heading">あなたが聞いた、その一言。</h2>
        <p class="share-description">会話や名前を載せない、物語のカードです。<br>気になったら、あなたの言葉を添えて。</p>
        <canvas class="share-preview" id="share-canvas" width="1080" height="1350" role="img" aria-label="ミリーちゃんの匿名共有カード"></canvas>
        <div class="share-buttons">
          <button class="outline-button primary-button" type="button" id="download">画像を保存</button>
          <button class="outline-button" type="button" id="native-share" hidden>画像を共有</button>
          <button class="outline-button" type="button" id="copy-share">紹介文をコピー</button>
        </div>
        <p class="share-status" id="share-status" role="status" aria-live="polite"></p>
        <div class="copy-fallback" id="copy-fallback" hidden><label for="copy-text">紹介文を選択してコピーできます</label><textarea id="copy-text" readonly></textarea></div>
      </section>
      <p class="footer-note">この体験は原作に着想を得た制作確認用の新演出案です。現在公開中のLINEの挙動とは異なります。</p>
    </aside>
    <section class="phone" id="phone" aria-label="ミリーちゃんとの会話サンプル">
      <header class="chat-head">
        <div class="avatar" aria-hidden="true"><span class="avatar-fallback">ミ</span><img id="millie-avatar" src="__ICON__" alt="" onerror="this.hidden=true"></div>
        <div><div class="chat-name">ミリーちゃん</div><div class="chat-subtitle" id="chat-subtitle">あなたの話、聞かせて。</div></div>
        <div class="head-label">会話サンプル</div>
      </header>
      <div class="chat-scroll" id="chat-scroll" tabindex="0" aria-label="会話の履歴">
        <div class="date-divider" id="date-divider">今日</div>
        <ol class="chat-log" id="chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-label="会話"></ol>
        <div class="starters" id="starters" hidden>
          <div class="starters-title">こんなことから、話してみる？</div>
          <button type="button" class="starter" data-message="友だちといると、ちょっと疲れる">友だちといると、ちょっと疲れる</button>
          <button type="button" class="starter" data-message="好きな人から返事がこない">好きな人から返事がこない</button>
          <button type="button" class="starter" data-message="誰かに必要とされたい">誰かに必要とされたい</button>
        </div>
      </div>
      <div class="chat-bottom">
        <div class="quick-actions" aria-label="会話メニュー">
          <button type="button" class="chip" data-command="うらない">うらない</button>
          <button type="button" class="chip" data-command="こわいはなし">こわいはなし</button>
          <button type="button" class="chip" data-command="共有">共有</button>
          <button type="button" class="chip" data-command="もう一度">もう一度</button>
          <button type="button" class="chip stop" id="stop">停止</button>
        </div>
        <form class="composer" id="composer">
          <label for="message" class="sr-only">ミリーちゃんに送るメッセージ</label>
          <div class="input-wrap"><textarea id="message" name="message" rows="1" maxlength="1000" placeholder="ミリーちゃんに話しかける" autocomplete="off" enterkeyhint="send"></textarea></div>
          <button class="send" type="submit" id="send" aria-label="メッセージを送る" disabled><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4 4 17 8-17 8 4-8-4-8Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 12h12" stroke="currentColor" stroke-width="1.7"/></svg></button>
        </form>
        <p class="composer-message" id="composer-status" role="status" aria-live="polite"></p>
        <div class="privacy-note">会話はこの画面の中だけ。閉じると消えます。</div>
      </div>
    </section>
    <p class="mobile-note">原作をもとにした新しい会話演出の体験版です。<br><a href="https://youtu.be/4jJUsXAld6Y" target="_blank" rel="noopener noreferrer">原作動画</a> ／ <a href="https://line.me/R/ti/p/@575kepfk" target="_blank" rel="noopener noreferrer">公式LINE</a></p>
  </main>
</div>
<script>
__CORE__
</script>
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var log = $('chat-log');
  var scroll = $('chat-scroll');
  var input = $('message');
  var phone = $('phone');
  var threshold = [0, 5, 10, 15, 20, 25, 30, 38, 45, 52];
  var phaseNames = ['いつものミリーちゃん', 'あなたの気持ち', '少しだけ、こわい話', 'こわいのは、どっち？', '時刻と場所', 'ミリーちゃんからの誘い', '行く？ ここにいる？', 'ことばの向こう', '夜が明ける、その前に', 'あなたが聞いた結末'];
  var state;
  var busy = false;
  var generation = 0;
  var composing = false;
  var shareCard = null;
  var shareBlob = null;
  var shareGeneration = 0;
  var avatar = $('millie-avatar');
  var userId = 'sample-local-user';

  function dateKeyJST(value) {
    var parts = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));
    var values = {};
    parts.forEach(function (part) { values[part.type] = part.value; });
    return values.year + '-' + values.month + '-' + values.day;
  }

  function context() {
    var current = new Date();
    var selected = $('time-preview').value;
    if (selected !== 'now') current = new Date(dateKeyJST(current) + 'T' + selected + ':00+09:00');
    return {now:current.toISOString(),dateKey:dateKeyJST(current)};
  }

  function timeLabel() {
    return new Intl.DateTimeFormat('ja-JP', {timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(context().now));
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function delay(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }
  function scrollToEnd() { scroll.scrollTop = scroll.scrollHeight; }

  function smallAvatar() {
    var outer = document.createElement('div');
    outer.className = 'avatar';
    outer.setAttribute('aria-hidden', 'true');
    var fallback = document.createElement('span');
    fallback.className = 'avatar-fallback';
    fallback.textContent = 'ミ';
    outer.appendChild(fallback);
    if (avatar && !avatar.hidden) {
      var image = avatar.cloneNode(false);
      image.removeAttribute('id');
      outer.appendChild(image);
    }
    return outer;
  }

  function appendMessage(speaker, text, isTyping) {
    var li = document.createElement('li');
    li.className = 'message ' + speaker;
    if (speaker === 'bot') li.appendChild(smallAvatar());
    var wrap = document.createElement('div');
    wrap.className = 'bubble-wrap';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    var who = document.createElement('span');
    who.className = 'sr-only';
    who.textContent = speaker === 'bot' ? 'ミリーちゃん：' : 'あなた：';
    bubble.appendChild(who);
    if (isTyping) {
      li.setAttribute('aria-hidden', 'true');
      var typing = document.createElement('span');
      typing.className = 'typing';
      for (var i=0;i<3;i++) typing.appendChild(document.createElement('span'));
      bubble.appendChild(typing);
    } else {
      var content = document.createElement('span');
      content.textContent = String(text);
      bubble.appendChild(content);
    }
    wrap.appendChild(bubble);
    if (!isTyping) {
      var time = document.createElement('div');
      time.className = 'message-time';
      time.textContent = speaker === 'user' ? '既読  ' + timeLabel() : timeLabel();
      wrap.appendChild(time);
    }
    li.appendChild(wrap);
    log.appendChild(li);
    scrollToEnd();
    return li;
  }

  function addSystem(text) {
    var li = document.createElement('li');
    li.className = 'system-line';
    li.textContent = text;
    log.appendChild(li);
    scrollToEnd();
  }

  function updateSendButton() { $('send').disabled = busy || !input.value.trim(); }

  function setBusy(value) {
    busy = value;
    input.disabled = value;
    $('composer').setAttribute('aria-busy', value ? 'true' : 'false');
    document.querySelectorAll('[data-command], [data-message], .phase-button, #share-preview, #time-preview').forEach(function (button) { button.disabled = value; });
    updateSendButton();
  }

  function renderState() {
    var phase = Math.max(1, Math.min(10, Number(state.phase) || 1));
    $('phase-value').textContent = String(phase).padStart(2, '0');
    $('count-value').textContent = String(Number(state.message_count) || 0);
    $('phase-label').textContent = phaseNames[phase - 1];
    document.body.dataset.phase = String(phase);
    phone.classList.toggle('night', phase >= 8);
    document.querySelectorAll('.phase-button').forEach(function (button) { button.setAttribute('aria-pressed', Number(button.dataset.phase) === phase ? 'true' : 'false'); });
    if (state.is_active === false) $('chat-subtitle').textContent = 'おやすみ中 ·「再開」でまた話せます';
    else if (state.ending_type) $('chat-subtitle').textContent = 'この夜のおはなしは、ここまで。';
    else $('chat-subtitle').textContent = phase >= 8 ? '……まだ、聞いてる？' : 'あなたの話、聞かせて。';
  }

  async function present(result, token, intro) {
    var messages = Array.isArray(result.messages) ? result.messages : [];
    for (var i = 0; i < messages.length; i++) {
      if (token !== generation) return;
      var dots = appendMessage('bot', '', true);
      await delay(300);
      if (token !== generation) return;
      dots.remove();
      appendMessage('bot', messages[i], false);
    }
    if (token !== generation) return;
    if (result.shareCard) await showShareCard(result.shareCard);
    if (token !== generation) return;
    if (intro) $('starters').hidden = false;
    renderState();
    setBusy(false);
    scrollToEnd();
  }

  async function send(text, options) {
    options = options || {};
    var normalized = String(text || '').trim();
    if (!normalized || busy) return;
    var token = generation;
    $('composer-status').textContent = '';
    $('starters').hidden = true;
    if (!options.silent) appendMessage('user', normalized, false);
    input.value = '';
    input.style.height = 'auto';
    setBusy(true);
    try {
      var result = MillieCore.respond(clone(state), normalized, context());
      if (!result || !result.user || !Array.isArray(result.messages)) throw new Error('Invalid core response');
      state = result.user;
      await present(result, token, !!options.intro);
    } catch (error) {
      if (token !== generation) return;
      addSystem('うまく言葉が届かなかったみたい。もう一度、話しかけてみてください。');
      $('review-status').textContent = '会話の処理に失敗しました。最初から試すこともできます。';
      setBusy(false);
      console.error('Millie sample could not produce a response.', error);
    }
  }

  function hideShareCard() {
    shareGeneration++;
    shareCard = null;
    shareBlob = null;
    $('share-section').hidden = true;
    $('share-status').textContent = '';
    $('native-share').hidden = true;
    $('copy-fallback').hidden = true;
    $('copy-text').value = '';
  }

  function resetConversation() {
    generation++;
    setBusy(false);
    log.replaceChildren();
    input.value = '';
    input.style.height = 'auto';
    $('composer-status').textContent = '';
    $('review-status').textContent = '新しい会話をはじめました。';
    hideShareCard();
    state = MillieCore.newUser(userId, context().now);
    renderState();
    send('__follow__', {silent:true,intro:true});
  }

  function stopConversation() {
    // Stop also cancels queued typing so that no old reply appears afterward.
    generation++;
    log.querySelectorAll('[aria-hidden="true"].message').forEach(function (node) { node.remove(); });
    setBusy(false);
    send('停止');
  }

  function previewPhase(phase) {
    generation++;
    setBusy(false);
    hideShareCard();
    log.replaceChildren();
    $('starters').hidden = true;
    state = MillieCore.newUser(userId, context().now);
    // The core counts an ordinary user message before selecting its phase.
    // At a threshold, the next message therefore enters the selected phase.
    state.message_count = phase === 1 ? 0 : threshold[phase - 1] - 1;
    state.phase = phase;
    state.is_active = true;
    renderState();
    addSystem('段階 ' + String(phase).padStart(2, '0') + ' の会話をプレビューしています。');
    $('review-status').textContent = '段階 ' + phase + ' を選びました。話しかけて、返事を確かめてください。';
    $('composer-status').textContent = '';
    updateSendButton();
    input.focus({preventScroll:true});
  }

  function wrapText(ctx, text, maxWidth) {
    var rows = [];
    var line = '';
    // Code points preserve surrogate pairs. Card content comes from fixed core
    // templates only; user input and history never reach this function.
    Array.from(String(text)).forEach(function (character) {
      if (character === '\n') { rows.push(line); line = ''; return; }
      if (line && ctx.measureText(line + character).width > maxWidth) { rows.push(line); line = character; }
      else line += character;
    });
    rows.push(line);
    return rows;
  }

  function drawShareCard(card) {
    var canvas = $('share-canvas');
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable');
    var width = canvas.width;
    var height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    var gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#3b2b45');
    gradient.addColorStop(.55, '#281f34');
    gradient.addColorStop(1, '#16131f');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    // Restrained stationery marks; no chat screenshot or profile image.
    ctx.strokeStyle = '#bda1ba55';
    ctx.lineWidth = 1;
    ctx.strokeRect(45, 45, width-90, height-90);
    ctx.fillStyle = '#bda1ba';
    ctx.font = '22px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.fillText('M I L L I E   /   A F T E R   D A R K', 95, 125);
    ctx.beginPath();
    ctx.moveTo(95, 160);ctx.lineTo(200, 160);ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e7d5e4';
    ctx.font = '32px "Yu Mincho", "Hiragino Mincho ProN", serif';
    var titleRows = wrapText(ctx, card.title, 820);
    var y = 335;
    titleRows.forEach(function (row) { ctx.fillText(row, width/2, y); y += 58; });
    y += 75;
    ctx.font = '43px "Yu Mincho", "Hiragino Mincho ProN", serif';
    ctx.fillStyle = '#f6eaf1';
    var bodyRows = [];
    card.lines.forEach(function (line, index) {
      if (index) bodyRows.push('');
      bodyRows = bodyRows.concat(wrapText(ctx, line, 820));
    });
    var lineHeight = bodyRows.length > 7 ? 59 : 73;
    if (bodyRows.length > 9) {
      ctx.font = '35px "Yu Mincho", "Hiragino Mincho ProN", serif';
      lineHeight = 52;
      bodyRows = [];
      card.lines.forEach(function (line, index) {
        if (index) bodyRows.push('');
        bodyRows = bodyRows.concat(wrapText(ctx, line, 850));
      });
    }
    bodyRows.slice(0, 12).forEach(function (row) { if (y < 1080) ctx.fillText(row, width/2, y); y += lineHeight; });
    ctx.strokeStyle = '#bda1ba55';
    ctx.beginPath();ctx.moveTo(430,1124);ctx.lineTo(650,1124);ctx.stroke();
    ctx.fillStyle = '#cab2c7';
    ctx.font = '26px "Yu Mincho", serif';
    ctx.fillText('ミリーちゃん', width/2, 1194);
    ctx.font = '19px "Hiragino Kaku Gothic ProN", sans-serif';
    ctx.fillStyle = '#a58fa7';
    ctx.fillText('あなたは、どんな話を聞いた？', width/2, 1246);
    ctx.font = '16px "Hiragino Kaku Gothic ProN", sans-serif';
    ctx.fillText('作品からの新しい会話演出案', width/2, 1284);
  }

  async function showShareCard(card) {
    // The core owns every public string. Never derive public content from
    // state.user_name, history, input, or a rendered chat bubble.
    // Re-read the allowlisted template; even a malformed caller cannot pass
    // arbitrary conversation content through title/lines.
    if (!card || typeof MillieCore.publicCard !== 'function') return;
    card = MillieCore.publicCard(card.id);
    if (!card || typeof card.title !== 'string' || !Array.isArray(card.lines) || !card.lines.every(function (line) {return typeof line === 'string';})) return;
    var token = ++shareGeneration;
    shareCard = {title:card.title,lines:card.lines.slice()};
    shareBlob = null;
    $('native-share').hidden = true;
    $('share-status').textContent = '';
    $('copy-fallback').hidden = true;
    $('share-section').hidden = false;
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      if (token !== shareGeneration) return;
      drawShareCard(shareCard);
      $('share-canvas').setAttribute('aria-label', shareCard.title + '。' + shareCard.lines.join('。'));
      var blob = await new Promise(function (resolve) { $('share-canvas').toBlob(resolve, 'image/png'); });
      if (token !== shareGeneration) return;
      shareBlob = blob;
      if (!blob) throw new Error('PNG generation failed');
      if (typeof File === 'function' && navigator.canShare && navigator.share) {
        try {
          var file = new File([blob], 'millie-story.png', {type:'image/png'});
          $('native-share').hidden = !navigator.canShare({files:[file]});
        } catch (error) { $('native-share').hidden = true; }
      }
      $('review-status').textContent = '共有カードを表示しました。個人の会話や名前は含まれません。';
    } catch (error) {
      if (token !== shareGeneration) return;
      $('share-status').textContent = 'この環境では画像を作れませんでした。紹介文のコピーは利用できます。';
    }
  }

  function publicShareText() {
    return 'ミリーちゃんに、話を聞いてもらった。\nあなたは、どんな話を聞く？\n#ミリーちゃん\nhttps://line.me/R/ti/p/@575kepfk\n原作：https://youtu.be/4jJUsXAld6Y';
  }

  async function copyShareText() {
    $('share-status').textContent = '';
    var text = publicShareText();
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      $('share-status').textContent = '紹介文をコピーしました。';
    } catch (error) {
      // Local files may lack clipboard permission. Keep a keyboard-accessible
      // fallback in the page and never claim copying succeeded.
      $('copy-fallback').hidden = false;
      $('copy-text').value = text;
      $('copy-text').focus();
      $('copy-text').select();
      $('share-status').textContent = '紹介文を表示しました。選択してコピーできます。';
    }
  }

  $('composer').addEventListener('submit', function (event) {
    event.preventDefault();
    if (!composing) send(input.value);
  });
  input.addEventListener('input', function () {
    updateSendButton();
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 94) + 'px';
  });
  input.addEventListener('compositionstart', function () { composing = true; });
  input.addEventListener('compositionend', function () { composing = false; });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !composing && event.keyCode !== 229) {
      event.preventDefault();
      send(input.value);
    }
  });
  document.querySelectorAll('[data-command]').forEach(function (button) {
    button.addEventListener('click', function () { send(button.dataset.command); });
  });
  document.querySelectorAll('[data-message]').forEach(function (button) {
    button.addEventListener('click', function () { send(button.dataset.message); });
  });
  for (var phase=1;phase<=10;phase++) {
    var button = document.createElement('button');
    button.type = 'button';button.className = 'phase-button';button.dataset.phase = String(phase);
    button.textContent = String(phase);button.setAttribute('aria-label','段階 ' + phase + '：' + phaseNames[phase-1]);
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', function (event) { previewPhase(Number(event.currentTarget.dataset.phase)); });
    $('phase-grid').appendChild(button);
  }
  $('time-preview').addEventListener('change', function () {
    var value = $('time-preview').value;
    $('date-divider').textContent = value === 'now' ? '今日' : '今日  ·  午前 ' + value.replace(/^0/,'');
    $('review-status').textContent = value === 'now' ? '実際の日本時間で試します。' : '日本時間の午前 ' + value.replace(/^0/,'') + ' として試します。';
  });
  $('reset').addEventListener('click', resetConversation);
  $('stop').addEventListener('click', stopConversation);
  $('share-preview').addEventListener('click', function () { send('共有'); });
  $('copy-share').addEventListener('click', copyShareText);
  $('download').addEventListener('click', function () {
    if (!shareBlob) { $('share-status').textContent = '画像を準備できませんでした。紹介文のコピーをお使いください。'; return; }
    var url = URL.createObjectURL(shareBlob);
    var anchor = document.createElement('a');
    anchor.href = url;anchor.download = 'millie-story.png';
    document.body.appendChild(anchor);anchor.click();anchor.remove();
    window.setTimeout(function () {URL.revokeObjectURL(url);}, 10000);
    $('share-status').textContent = '画像の保存を開始しました。';
  });
  $('native-share').addEventListener('click', async function () {
    if (!shareBlob || !navigator.share || typeof File !== 'function') return;
    try {
      await navigator.share({title:'ミリーちゃん',text:publicShareText(),files:[new File([shareBlob], 'millie-story.png', {type:'image/png'})]});
      $('share-status').textContent = '共有画面を開きました。';
    } catch (error) {
      $('share-status').textContent = error && error.name === 'AbortError' ? '共有を取り消しました。' : '画像を共有できませんでした。「画像を保存」をお使いください。';
    }
  });

  // Production systems and analytics are deliberately absent. All conversation
  // state lives in this closure until the page is reloaded or closed.
  if (typeof MillieCore === 'undefined') {
    $('composer-status').textContent = '会話サンプルを読み込めませんでした。制作担当者にお知らせください。';
    setBusy(true);
    $('stop').disabled = true;
    $('reset').disabled = true;
  } else {
    resetConversation();
    $('review-status').textContent = '';
  }
})();
</script>
</body>
</html>
'''


def main() -> None:
    if not CORE.is_file():
        raise SystemExit(f"Shared conversation core not found: {CORE}\nBuild again after Core.gs is available.")
    core = CORE.read_text(encoding="utf-8")
    if not re.search(r"\bMillieCore\b", core):
        raise SystemExit("Core.gs must define MillieCore")
    if re.search(r"</script", core, re.IGNORECASE):
        raise SystemExit("Core.gs contains a closing script tag; escape it before embedding")
    icon_url = "data:image/png;base64," + base64.b64encode(ICON.read_bytes()).decode("ascii") if ICON.is_file() else ""
    html = TEMPLATE.replace("__CORE__", core).replace("__ICON__", icon_url)
    paths = [HERE / "index.html", ROOT / "ミリーちゃん_作品準拠サンプル.html"]
    for path in paths:
        path.write_text(html, encoding="utf-8")
        print(f"Built {path} ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
