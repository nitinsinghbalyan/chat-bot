/*
 * Seller enquiry chat widget. Embed on any page:
 *
 *   <script src="https://YOUR-BOT-HOST/widget.js" defer
 *           data-api="https://YOUR-BOT-HOST"
 *           data-title="Jayshree Machinetools"
 *           data-color="#0b5cad"></script>
 *
 * Renders a chat bubble fixed to the bottom-left corner. Styles are isolated in a Shadow DOM.
 */
(function () {
  "use strict";
  if (window.__sellerChatLoaded) return;
  window.__sellerChatLoaded = true;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var ds = (script && script.dataset) || {};
  var API = (ds.api || (script ? new URL(script.src, location.href).origin : "")).replace(/\/$/, "");
  var TITLE = ds.title || "Jayshree Machinetools";
  var COLOR = /^#[0-9a-f]{3,8}$/i.test(ds.color || "") ? ds.color : "#0b5cad";
  var DEMO = ds.demo === "true";
  var GREETING =
    ds.greeting ||
    "Hi! I'm the " + TITLE + " assistant. Tell me which machine you're looking for and I'll help you find the right one.";
  var CHIPS = (ds.chips || "Press Brake|Shearing Machine|Laser Cutting Machine|Hydraulic Press").split("|");
  var STORE_KEY = "sellerChat:" + API;

  function load() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function save(state) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      /* storage unavailable: chat still works for this page view */
    }
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  var state = load() || {};
  if (!state.sessionId || Date.now() - (state.updatedAt || 0) > 2 * 60 * 60 * 1000) {
    state = { sessionId: newId(), history: [], askFor: null };
  }

  var host = document.createElement("div");
  host.setAttribute("data-seller-chat", "");
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif}" +
    ".bubble{position:fixed;left:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}" +
    ".bubble:hover{transform:scale(1.06)}.bubble svg{width:28px;height:28px}" +
    ".panel{position:fixed;left:20px;bottom:92px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;color:#1d2433;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden}" +
    ".panel.open{display:flex}" +
    ".head{background:var(--c);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}" +
    ".head .t{font-weight:600;font-size:15px;flex:1;line-height:1.2}.head .s{font-size:12px;opacity:.85;font-weight:400}" +
    ".head button{background:transparent;border:0;color:#fff;cursor:pointer;font-size:22px;line-height:1;padding:4px}" +
    ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f5f7fb}" +
    ".m{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}" +
    ".m.bot{background:#fff;border:1px solid #e3e8f0;align-self:flex-start;border-bottom-left-radius:4px}" +
    ".m.me{background:var(--c);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}" +
    ".m a{color:inherit;text-decoration:underline}" +
    ".typing{display:inline-flex;gap:4px}.typing i{width:6px;height:6px;border-radius:50%;background:#9aa5b8;animation:b 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}" +
    "@keyframes b{0%,80%,100%{opacity:.3}40%{opacity:1}}" +
    ".chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;background:#f5f7fb}" +
    ".chip{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:999px;padding:6px 11px;font-size:13px;cursor:pointer}" +
    ".chip:hover{background:var(--c);color:#fff}" +
    "form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e8f0;background:#fff}" +
    "input{flex:1;border:1px solid #cfd6e2;border-radius:10px;padding:10px 12px;font-size:15px;outline:none;min-width:0;color:#1d2433;background:#fff}" +
    "input:focus{border-color:var(--c)}" +
    "form button{background:var(--c);color:#fff;border:0;border-radius:10px;padding:0 14px;font-size:14px;cursor:pointer}" +
    "form button:disabled{opacity:.5;cursor:default}" +
    ".hint{font-size:11px;color:#6b7588;padding:0 14px 6px;background:#fff}" +
    ".foot{font-size:11px;color:#8b94a7;text-align:center;padding:0 0 8px;background:#fff}" +
    "@media (max-width:480px){.panel{left:0;right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}.bubble{left:16px;bottom:16px}}" +
    "</style>" +
    '<button class="bubble" aria-label="Chat with us" aria-expanded="false">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    "</button>" +
    '<section class="panel" role="dialog" aria-label="Chat">' +
    '<div class="head"><div class="t"></div><button class="x" aria-label="Close chat">×</button></div>' +
    '<div class="log" aria-live="polite"></div>' +
    '<div class="chips"></div>' +
    '<div class="hint" hidden></div>' +
    '<form><input aria-label="Type your message" autocomplete="off" maxlength="1000"/><button type="submit">Send</button></form>' +
    '<div class="foot">Virtual assistant · replies may be checked by our team</div>' +
    "</section>";

  root.host.style.setProperty("--c", COLOR);
  var bubble = root.querySelector(".bubble");
  var panel = root.querySelector(".panel");
  var log = root.querySelector(".log");
  var chips = root.querySelector(".chips");
  var hint = root.querySelector(".hint");
  var form = root.querySelector("form");
  var input = root.querySelector("input");
  var sendBtn = root.querySelector("form button");
  root.querySelector(".t").innerHTML = escapeHtml(TITLE) + '<div class="s">Typically replies instantly</div>';

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function linkify(text) {
    return escapeHtml(text).replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, function (url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + "</a>";
    });
  }
  function addMsg(who, text) {
    var el = document.createElement("div");
    el.className = "m " + who;
    el.innerHTML = linkify(text);
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function setAskFor(kind) {
    state.askFor = kind;
    input.value = "";
    input.type = "text";
    input.removeAttribute("inputmode");
    input.removeAttribute("pattern");
    input.setAttribute("autocomplete", "off");
    input.maxLength = 1000;
    hint.hidden = true;
    if (kind === "mobile") {
      input.type = "tel";
      input.setAttribute("inputmode", "tel");
      input.setAttribute("autocomplete", "tel-national");
      input.maxLength = 14;
      input.placeholder = "10-digit mobile number";
    } else if (kind === "otp") {
      input.setAttribute("inputmode", "numeric");
      input.setAttribute("autocomplete", "one-time-code");
      input.maxLength = 8;
      input.placeholder = "Enter the OTP";
      if (DEMO) {
        hint.textContent = "Demo mode: the OTP is 12345";
        hint.hidden = false;
      }
    } else if (kind === "name") {
      input.setAttribute("autocomplete", "name");
      input.maxLength = 100;
      input.placeholder = "Your name";
    } else {
      input.placeholder = "Type your message…";
    }
  }
  function persist() {
    state.updatedAt = Date.now();
    state.history = state.history.slice(-60);
    save(state);
  }

  function render() {
    log.innerHTML = "";
    addMsg("bot", GREETING);
    state.history.forEach(function (h) {
      addMsg(h.who, h.text);
    });
    chips.innerHTML = "";
    if (state.history.length === 0) {
      CHIPS.forEach(function (label) {
        var b = document.createElement("button");
        b.className = "chip";
        b.type = "button";
        b.textContent = label;
        b.onclick = function () {
          send("I'm looking for a " + label);
        };
        chips.appendChild(b);
      });
    }
    setAskFor(state.askFor);
  }

  var sending = false;
  function send(text) {
    text = (text || "").trim();
    if (!text || sending) return;
    sending = true;
    sendBtn.disabled = true;
    chips.innerHTML = "";
    var display = state.askFor === "otp" ? "•".repeat(Math.min(text.length, 8)) : text;
    addMsg("me", display);
    state.history.push({ who: "me", text: display });
    setAskFor(null);
    var botEl = addMsg("bot", "");
    botEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    var reply = "";

    fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: text, pageUrl: location.href }),
    })
      .then(function (res) {
        if (!res.ok || !res.body) {
          return res.json().then(
            function (j) {
              throw new Error(j.error || "Request failed");
            },
            function () {
              throw new Error("Request failed");
            },
          );
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return;
            buf += decoder.decode(r.value, { stream: true });
            var parts = buf.split("\n\n");
            buf = parts.pop();
            parts.forEach(handleEvent);
            return pump();
          });
        }
        function handleEvent(raw) {
          var ev = "message";
          var data = "";
          raw.split("\n").forEach(function (line) {
            if (line.indexOf("event: ") === 0) ev = line.slice(7);
            else if (line.indexOf("data: ") === 0) data += line.slice(6);
          });
          var payload = {};
          try {
            payload = JSON.parse(data || "{}");
          } catch (e) {
            return;
          }
          if (ev === "session" && payload.sessionId) state.sessionId = payload.sessionId;
          else if (ev === "text") {
            reply += payload.text;
            botEl.innerHTML = linkify(reply.replace(/^\s+/, ""));
            log.scrollTop = log.scrollHeight;
          } else if (ev === "ui") state.askFor = payload.askFor || null;
          else if (ev === "error") throw new Error(payload.error);
        }
        return pump();
      })
      .catch(function (err) {
        reply = reply || (err && err.message) || "Sorry, something went wrong. Please try again.";
        botEl.innerHTML = linkify(reply);
      })
      .then(function () {
        reply = reply.trim() || "Sorry, something went wrong. Please try again.";
        botEl.innerHTML = linkify(reply);
        state.history.push({ who: "bot", text: reply });
        sending = false;
        sendBtn.disabled = false;
        setAskFor(state.askFor);
        persist();
        input.focus();
      });
  }

  bubble.addEventListener("click", function () {
    var open = !panel.classList.contains("open");
    panel.classList.toggle("open", open);
    bubble.setAttribute("aria-expanded", String(open));
    if (open) {
      render();
      input.focus();
    }
  });
  root.querySelector(".x").addEventListener("click", function () {
    panel.classList.remove("open");
    bubble.setAttribute("aria-expanded", "false");
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });
})();
