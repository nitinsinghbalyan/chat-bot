/*
 * Seller enquiry chat widget. Embed on any page:
 *
 *   <script src="https://YOUR-BOT-HOST/widget.js" defer data-seller="jayshree-machinetools"></script>
 *
 * Renders a chat bubble fixed to the bottom-right corner (or bottom-left, if the seller's
 * widgetPosition is "left" or the tag has data-position="left"), styled for that seller.
 * Styles are isolated in a Shadow DOM. Without data-seller nothing shows until a page calls:
 *
 *   SellerChat.open("seller-slug", { message: "optional first message" })
 *   SellerChat.close()
 *   SellerChat.reset()   // start a new conversation (the header's "New chat" button does the same)
 */
(function () {
  "use strict";
  if (window.SellerChat) return;

  var script = document.currentScript || document.querySelector('script[src*="widget.js"]');
  var ds = (script && script.dataset) || {};
  var API = (ds.api || (script ? new URL(script.src, location.href).origin : "")).replace(/\/$/, "");
  var DEMO = ds.demo === "true";
  var TTL = 2 * 60 * 60 * 1000;

  var configs = {}; // slug -> config from /api/sellers/:slug
  var current = null; // slug
  var state = null; // per-seller chat state
  var sending = false;

  function storeKey(slug) {
    return "sellerChat:" + API + ":" + slug;
  }
  function load(slug) {
    var s = null;
    try {
      s = JSON.parse(localStorage.getItem(storeKey(slug)) || "null");
    } catch (e) {
      s = null;
    }
    if (!s || !s.sessionId || Date.now() - (s.updatedAt || 0) > TTL) s = { sessionId: newId(), history: [], askFor: null };
    return s;
  }
  function persist() {
    if (!current || !state) return;
    state.updatedAt = Date.now();
    state.history = state.history.slice(-40);
    try {
      localStorage.setItem(storeKey(current), JSON.stringify(state));
    } catch (e) {
      /* storage unavailable: chat still works for this page view */
    }
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function fetchConfig(slug) {
    if (configs[slug]) return Promise.resolve(configs[slug]);
    return fetch(API + "/api/sellers/" + encodeURIComponent(slug))
      .then(function (r) {
        if (!r.ok) throw new Error("Unknown seller");
        return r.json();
      })
      .then(function (c) {
        if (ds.title && slug === ds.seller) c.name = ds.title;
        if (ds.color && slug === ds.seller && /^#[0-9a-f]{6}$/i.test(ds.color)) c.color = ds.color;
        configs[slug] = c;
        return c;
      });
  }

  var host = document.createElement("div");
  host.setAttribute("data-seller-chat", "");
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });

  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    "*{box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'Noto Sans',sans-serif}" +
    "[hidden]{display:none!important}" +
    ".bubble{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s}" +
    ".bubble:hover{transform:scale(1.06)}.bubble svg{width:28px;height:28px}" +
    ".panel{position:fixed;right:20px;bottom:92px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;color:#1d2433;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden}" +
    ".panel.open{display:flex}" +
    ".head{background:var(--c);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}" +
    ".head .t{font-weight:600;font-size:15px;flex:1;line-height:1.2}.head .s{font-size:12px;opacity:.85;font-weight:400}" +
    ".head button{background:transparent;border:0;color:#fff;cursor:pointer;font-size:22px;line-height:1;padding:4px;border-radius:6px;display:flex;align-items:center}" +
    ".head button:hover{background:rgba(255,255,255,.16)}.head button:disabled{opacity:.45;cursor:default;background:transparent}.head .new svg{width:18px;height:18px}" +
    ".log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f5f7fb}" +
    ".m{flex-shrink:0;max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}" +
    ".m.bot{background:#fff;border:1px solid #e3e8f0;align-self:flex-start;border-bottom-left-radius:4px}" +
    ".m.me{background:var(--c);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}" +
    ".m a{color:inherit;text-decoration:underline}" +
    ".typing{display:inline-flex;gap:4px}.typing i{width:6px;height:6px;border-radius:50%;background:#9aa5b8;animation:b 1s infinite}.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}" +
    "@keyframes b{0%,80%,100%{opacity:.3}40%{opacity:1}}" +
    ".chips{display:flex;flex-shrink:0;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:92%;margin-top:-2px}" +
    ".chip{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:999px;padding:6px 11px;font-size:13px;line-height:1.3;cursor:pointer;text-align:left}" +
    ".chips.live .chip:hover{background:var(--c);color:#fff}" +
    ".chips.used .chip{cursor:default;opacity:.45;border-color:#cfd6e2;color:#6b7588}" +
    ".chips.used .chip.picked{opacity:1;border-color:var(--c);color:var(--c)}" +
    ".fb{display:flex;flex-shrink:0;gap:2px;align-items:center;align-self:flex-start;margin:0 0 0 4px;font-size:12px;color:#6b7588}.fb span{margin-right:4px}" +
    ".fb button{border:0;background:transparent;cursor:pointer;font-size:13px;line-height:1;padding:3px 5px;border-radius:6px;opacity:.45;filter:grayscale(1)}" +
    ".fb button:hover{opacity:.9;background:#e9edf3}.fb button.on{opacity:1;filter:none;background:#e9edf3}" +
    "form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e8f0;background:#fff}" +
    "input{flex:1;border:1px solid #cfd6e2;border-radius:10px;padding:10px 12px;font-size:15px;outline:none;min-width:0;color:#1d2433;background:#fff}" +
    "input:focus{border-color:var(--c)}" +
    "form button{background:var(--c);color:#fff;border:0;border-radius:10px;padding:0 14px;font-size:14px;cursor:pointer}" +
    "form button:disabled{opacity:.5;cursor:default}" +
    ".hint{font-size:11px;color:#6b7588;padding:0 14px 6px;background:#fff}" +
    ".foot{font-size:11px;color:#8b94a7;text-align:center;padding:0 0 8px;background:#fff}" +
    ":host([data-pos=left]) .bubble,:host([data-pos=left]) .panel{right:auto;left:20px}" +
    ".cards{display:flex;flex-shrink:0;gap:8px;overflow-x:auto;padding:2px 2px 6px;align-self:stretch;scroll-snap-type:x mandatory;scrollbar-width:thin}" +
    ".card{flex:0 0 150px;scroll-snap-align:start;background:#fff;border:1px solid #e3e8f0;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;cursor:pointer;text-align:left;padding:0;font:inherit;color:#1d2433;text-decoration:none}" +
    ".card:hover{border-color:var(--c)}" +
    ".card .th{position:relative;width:100%;height:104px;background:#eef2f7 center/cover no-repeat;display:flex;align-items:center;justify-content:center}" +
    ".card .th img{width:100%;height:100%;object-fit:cover;display:block}" +
    ".card .play{position:absolute;width:38px;height:38px;border-radius:50%;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}.card .play svg{width:16px;height:16px;fill:#fff;margin-left:2px}" +
    ".card .pdf{font-weight:700;font-size:15px;color:#c0392b;border:2px solid #c0392b;border-radius:6px;padding:6px 8px}" +
    ".card .cb{padding:7px 9px 9px;display:flex;flex-direction:column;gap:2px}" +
    ".card .ct{font-size:12.5px;font-weight:600;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}" +
    ".card .cs{font-size:11px;color:#6b7588;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".card .ca{font-size:11.5px;color:var(--c);font-weight:600;margin-top:2px}" +
    ".sum{flex-shrink:0;align-self:stretch;background:#fff;border:1px solid #e3e8f0;border-top:3px solid var(--c);border-radius:12px;padding:10px 12px;font-size:13px;color:#1d2433}" +
    ".sum h4{margin:0 0 6px;font-size:13px;font-weight:700;color:var(--c)}" +
    ".sum dl{display:grid;grid-template-columns:minmax(80px,auto) 1fr;gap:4px 12px;margin:0}" +
    ".sum dt{color:#6b7588;overflow-wrap:anywhere}.sum dd{margin:0;font-weight:600;overflow-wrap:anywhere}" +
    ".sum .n{margin-top:8px;padding-top:7px;border-top:1px solid #eef1f5;font-size:12px;color:#4a5466}" +
    ".lb{position:fixed;inset:0;z-index:2147483001;background:rgba(10,14,20,.88);display:none;align-items:center;justify-content:center;padding:48px 16px 16px}" +
    ".lb.open{display:flex}.lb .lbx{position:absolute;top:10px;right:14px;background:transparent;border:0;color:#fff;font-size:30px;cursor:pointer;line-height:1}" +
    ".lb .lbc{max-width:min(960px,100%);max-height:100%;width:100%;display:flex;flex-direction:column;align-items:center;gap:10px}" +
    ".lb img{max-width:100%;max-height:calc(100vh - 130px);object-fit:contain;border-radius:8px;background:#fff}" +
    ".lb iframe,.lb video{width:100%;aspect-ratio:16/9;max-height:calc(100vh - 130px);border:0;border-radius:8px;background:#000}" +
    ".lb .lbt{color:#fff;font-size:14px;text-align:center}.lb .lbt a{color:#fff}" +
    "@media (max-width:480px){.panel,:host([data-pos=left]) .panel{left:0;right:0;bottom:0;width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0}.bubble{right:16px;bottom:16px}:host([data-pos=left]) .bubble{left:16px}}" +
    "</style>" +
    '<button class="bubble" aria-label="Chat with us" aria-expanded="false" hidden>' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
    "</button>" +
    '<section class="panel" role="dialog" aria-label="Chat">' +
    '<div class="head"><div class="t"></div>' +
    '<button type="button" class="new" aria-label="Start a new chat" title="New chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>' +
    '<button type="button" class="x" aria-label="Close chat" title="Close">×</button></div>' +
    '<div class="log" aria-live="polite"></div>' +
    '<div class="hint" hidden></div>' +
    '<form><input aria-label="Type your message" autocomplete="off" maxlength="1000"/><button type="submit">Send</button></form>' +
    '<div class="foot">Virtual assistant · replies may be checked by our team</div>' +
    "</section>" +
    '<div class="lb" role="dialog" aria-label="Media viewer"><button type="button" class="lbx" aria-label="Close">×</button><div class="lbc"></div></div>';

  var bubble = root.querySelector(".bubble");
  var panel = root.querySelector(".panel");
  var log = root.querySelector(".log");
  var hint = root.querySelector(".hint");
  var form = root.querySelector("form");
  var input = root.querySelector("input");
  var sendBtn = root.querySelector("form button");
  var titleEl = root.querySelector(".t");
  var newBtn = root.querySelector(".new");
  var lightbox = root.querySelector(".lb");
  var lightboxBody = root.querySelector(".lbc");

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
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
  function safeHref(u) {
    try {
      var x = new URL(u);
      return x.protocol === "https:" || x.protocol === "http:" ? x.href : null;
    } catch (e) {
      return null;
    }
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  function openLightbox(card) {
    lightboxBody.innerHTML = "";
    var href = safeHref(card.url);
    if (card.type === "image") {
      var img = el("img");
      img.src = safeHref(card.url) || "";
      img.alt = card.title || "";
      img.referrerPolicy = "no-referrer";
      lightboxBody.appendChild(img);
    } else if (card.type === "video") {
      var embed = safeHref(card.embed);
      if (embed && /\.(mp4|webm)(\?|$)/i.test(embed)) {
        var v = el("video");
        v.src = embed;
        v.controls = true;
        v.autoplay = true;
        lightboxBody.appendChild(v);
      } else if (embed) {
        var f = el("iframe");
        f.src = embed;
        f.title = card.title || "Video";
        f.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
        f.allowFullscreen = true;
        f.referrerPolicy = "strict-origin-when-cross-origin";
        lightboxBody.appendChild(f);
      }
    }
    var cap = el("div", "lbt", card.title || "");
    if (href) {
      cap.appendChild(document.createTextNode(card.title ? " · " : ""));
      var a = el("a", "", card.type === "video" ? "Open video" : "Open full size");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      cap.appendChild(a);
    }
    lightboxBody.appendChild(cap);
    lightbox.classList.add("open");
  }
  function closeLightbox() {
    lightbox.classList.remove("open");
    lightboxBody.innerHTML = "";
  }
  function cardEl(card) {
    var href = safeHref(card.url);
    if (!href) return null;
    var lightboxable = card.type === "image" || (card.type === "video" && safeHref(card.embed));
    var c;
    if (lightboxable) {
      c = el("button", "card");
      c.type = "button";
      c.addEventListener("click", function () {
        openLightbox(card);
      });
    } else {
      c = el("a", "card");
      c.href = href;
      c.target = "_blank";
      c.rel = "noopener noreferrer";
    }
    var th = el("div", "th");
    var thumb = safeHref(card.thumb);
    if (thumb) {
      var img = el("img");
      img.src = thumb;
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.onerror = function () {
        img.remove();
      };
      th.appendChild(img);
    } else if (card.type === "document") {
      th.appendChild(el("span", "pdf", "PDF"));
    }
    if (card.type === "video") {
      var play = el("span", "play");
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
      th.appendChild(play);
    }
    c.appendChild(th);
    var body = el("div", "cb");
    body.appendChild(el("div", "ct", card.title || ""));
    if (card.subtitle) body.appendChild(el("div", "cs", card.subtitle));
    body.appendChild(el("div", "ca", { product: "View product", image: "View photo", video: "Play video", document: "Open PDF" }[card.type] || "Open"));
    c.appendChild(body);
    c.setAttribute("aria-label", ({ product: "Product", image: "Photo", video: "Video", document: "Document" }[card.type] || "") + ": " + (card.title || ""));
    return c;
  }
  function addCards(cards) {
    if (!cards || !cards.length) return;
    var wrap = el("div", "cards");
    cards.forEach(function (card) {
      var c = cardEl(card);
      if (c) wrap.appendChild(c);
    });
    if (!wrap.children.length) return;
    log.appendChild(wrap);
    log.scrollTop = log.scrollHeight;
  }
  /** The enquiry summary card (built by the server from the saved enquiry); text only, never HTML. */
  function addSummary(summary) {
    if (!summary || !summary.rows || !summary.rows.length) return;
    var box = el("div", "sum");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Your enquiry");
    box.appendChild(el("h4", "", "Your enquiry"));
    var dl = el("dl");
    summary.rows.forEach(function (r) {
      dl.appendChild(el("dt", "", String(r.label || "")));
      dl.appendChild(el("dd", "", String(r.value || "")));
    });
    box.appendChild(dl);
    if (summary.note) box.appendChild(el("div", "n", String(summary.note)));
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;
  }
  /**
   * "Was this helpful? 👍 👎", once per chat: under the latest enquiry summary (only when the
   * server records feedback). The vote is kept for the chat and sent with that reply's trace.
   */
  function addFeedback(entry) {
    var c = configs[current];
    if (!c || !c.feedback || !entry || !entry.traceId || !entry.summary) return;
    Array.prototype.forEach.call(log.querySelectorAll(".fb"), function (x) { x.remove(); });
    var row = document.createElement("div");
    row.className = "fb";
    row.appendChild(el("span", "", "Was this helpful?"));
    [
      [1, "\uD83D\uDC4D", "Helpful"],
      [-1, "\uD83D\uDC4E", "Not helpful"],
    ].forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = o[1];
      b.title = o[2];
      b.setAttribute("aria-label", o[2]);
      b.setAttribute("aria-pressed", state.vote === o[0] ? "true" : "false");
      if (state.vote === o[0]) b.className = "on";
      b.onclick = function () {
        if (state.vote === o[0]) return;
        state.vote = o[0];
        Array.prototype.forEach.call(row.querySelectorAll("button"), function (x) {
          x.className = "";
          x.setAttribute("aria-pressed", "false");
        });
        b.className = "on";
        b.setAttribute("aria-pressed", "true");
        persist();
        fetch(API + "/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seller: current, sessionId: state.sessionId, traceId: entry.traceId, value: o[0] }),
        }).catch(function () {
          /* feedback is best-effort */
        });
      };
      row.appendChild(b);
    });
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  }

  /**
   * Reply buttons inline in the conversation, right under the bot message that asked. Tapping one
   * sends it as the buyer's answer. Once the buyer replies, the row stays as a greyed-out record
   * with the chosen option highlighted (`picked`). Only the newest row is live.
   */
  function addChips(list, opts) {
    opts = opts || {};
    if (!list || !list.length) return null;
    var row = document.createElement("div");
    row.className = "chips " + (opts.live ? "live" : "used");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Suggested replies");
    list.forEach(function (label) {
      var b = document.createElement("button");
      b.className = "chip" + (opts.picked === label ? " picked" : "");
      b.type = "button";
      b.textContent = label;
      if (opts.live) {
        b.onclick = function () {
          send(opts.prefix ? opts.prefix + label : label, label);
        };
      } else b.disabled = true;
      row.appendChild(b);
    });
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }
  /** Retires the live chip row once the buyer answers; returns the option they tapped or typed, if any. */
  function retireChips(text, tapped) {
    var row = log.querySelector(".chips.live");
    if (!row) return null;
    row.className = "chips used";
    var picked = null;
    Array.prototype.forEach.call(row.querySelectorAll(".chip"), function (b) {
      b.disabled = true;
      b.onclick = null;
      if (b.textContent === tapped || (!tapped && b.textContent.toLowerCase() === text.toLowerCase())) {
        b.className = "chip picked";
        picked = b.textContent;
      }
    });
    return picked;
  }

  function greeting(c) {
    // The same welcome for every seller (sent by the server); it asks the buyer nothing.
    return c.greeting || "Welcome to " + c.name + ". I can tell you about our products, share photos and brochures, and pass your enquiry to our team.";
  }
  function setAskFor(kind) {
    if (state) state.askFor = kind;
    input.value = "";
    input.type = "text";
    input.removeAttribute("inputmode");
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
      if (DEMO || configs[current] && configs[current].demo) {
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

  function render() {
    var c = configs[current];
    root.host.style.setProperty("--c", c.color || "#0b5cad");
    root.host.setAttribute("data-pos", (ds.position || c.position) === "left" ? "left" : "right");
    titleEl.innerHTML = escapeHtml(c.name) + '<div class="s">Typically replies instantly</div>';
    bubble.setAttribute("aria-label", "Chat with " + c.name);
    log.innerHTML = "";
    addMsg("bot", greeting(c));
    var last = state.history.length - 1;
    var lastSummary = -1;
    state.history.forEach(function (h, i) {
      if (h.summary) lastSummary = i;
    });
    state.history.forEach(function (h, i) {
      if (h.text) addMsg(h.who, h.text);
      addCards(h.cards);
      addSummary(h.summary);
      // Older saved chats kept the last options only in state.chips.
      var rowChips = h.chips || (i === last && h.who === "bot" ? state.chips : null);
      if (rowChips) addChips(rowChips, i === last && state.chips ? { live: true } : { picked: h.picked });
      if (i === lastSummary) addFeedback(h);
    });
    setAskFor(state.askFor);
  }

  function select(slug) {
    return fetchConfig(slug).then(function () {
      if (current !== slug) {
        persist();
        current = slug;
        state = load(slug);
      }
      bubble.hidden = false;
      render();
    });
  }

  function openPanel() {
    panel.classList.add("open");
    bubble.setAttribute("aria-expanded", "true");
    input.focus();
  }
  function closePanel() {
    panel.classList.remove("open");
    bubble.setAttribute("aria-expanded", "false");
  }

  function send(text, tapped) {
    text = (text || "").trim();
    if (!text || sending || !current) return;
    sending = true;
    sendBtn.disabled = true;
    newBtn.disabled = true;
    var picked = retireChips(text, tapped);
    var prev = state.history[state.history.length - 1];
    if (picked && prev && prev.who === "bot" && prev.chips) prev.picked = picked;
    state.chips = null;
    var seller = current;
    var display = state.askFor === "otp" ? "•".repeat(Math.min(text.length, 8)) : text;
    addMsg("me", display);
    state.history.push({ who: "me", text: display });
    setAskFor(null);
    var botEl = addMsg("bot", "");
    botEl.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    var reply = "";
    var replyCards = null;
    var replyChips = null;
    var replyTrace = null;
    var replySummary = null;

    fetch(API + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seller: seller, sessionId: state.sessionId, message: text, pageUrl: location.href }),
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
          } else if (ev === "cards") replyCards = payload.cards || null;
          else if (ev === "trace") replyTrace = payload.traceId || null;
          else if (ev === "summary") replySummary = payload.summary || null;
          else if (ev === "ui") {
            state.askFor = payload.askFor || null;
            replyChips = payload.chips && payload.chips.length ? payload.chips : null;
          }
          else if (ev === "error") throw new Error(payload.error);
        }
        return pump();
      })
      .catch(function (err) {
        reply = reply || (err && err.message) || "Sorry, something went wrong. Please try again.";
      })
      .then(function () {
        reply = reply.trim() || "Sorry, something went wrong. Please try again.";
        botEl.innerHTML = linkify(reply);
        addCards(replyCards);
        addSummary(replySummary);
        var entry = { who: "bot", text: reply };
        if (replyCards) entry.cards = replyCards;
        if (replySummary) entry.summary = replySummary;
        if (replyChips) entry.chips = replyChips;
        if (replyTrace) entry.traceId = replyTrace;
        state.history.push(entry);
        state.chips = replyChips;
        addChips(replyChips, { live: true });
        addFeedback(entry);
        sending = false;
        sendBtn.disabled = false;
        newBtn.disabled = false;
        setAskFor(state.askFor);
        persist();
        input.focus();
      });
  }

  /** Starts a fresh conversation: new session id, empty history. The old chat stays on the server for the team. */
  function reset(ask) {
    if (sending || !current || !state) return false;
    if (ask && state.history.length && !window.confirm("Start a new chat? This conversation will be cleared.")) return false;
    state = { sessionId: newId(), history: [], askFor: null, chips: null };
    persist();
    render();
    input.focus();
    return true;
  }

  newBtn.addEventListener("click", function () {
    reset(true);
  });
  bubble.addEventListener("click", function () {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });
  root.querySelector(".x").addEventListener("click", closePanel);
  lightbox.querySelector(".lbx").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", function (e) {
    if (e.target === lightbox) closeLightbox();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && lightbox.classList.contains("open")) closeLightbox();
  });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });

  window.SellerChat = {
    /** Opens the chat for a seller (switching seller if needed), optionally sending a first message. */
    open: function (slug, opts) {
      opts = opts || {};
      return select(slug || current || ds.seller)
        .then(function () {
          openPanel();
          if (opts.message) send(opts.message);
        })
        .catch(function (err) {
          console.error("[SellerChat]", err);
        });
    },
    close: closePanel,
    /** Starts a new conversation with the current seller (no confirmation). */
    reset: function () {
      return reset(false);
    },
  };

  if (ds.seller) {
    select(ds.seller).catch(function (err) {
      console.error("[SellerChat]", err);
    });
  }
})();
