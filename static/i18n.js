/*
 * Mnemosyne Dashboard — runtime i18n engine
 * ---------------------------------------------------------------
 * Zero-intrusion design: the dashboard's HTML/JS contain hardcoded English.
 * Rather than rewriting 390+ strings across 3,700 lines of app.js, this engine
 * translates at runtime by matching exact English text nodes and attributes
 * against a dictionary keyed by the English source string.
 *
 * Features:
 *   - exact text-node & attribute replacement (placeholder / aria-label / title / alt)
 *   - MutationObserver to catch dynamically injected nodes (innerHTML templates)
 *   - locale persistence in localStorage
 *   - <html lang> sync and a drop-in language switcher
 *   - graceful fallback: untranslated strings stay as-is (English)
 *
 * Public API (window.I18n):
 *   I18n.init()                 -> Promise, load saved locale + translate
 *   I18n.setLocale('zh-CN'|'en')-> Promise, switch + persist
 *   I18n.getLocale()            -> current locale code
 *   I18n.t('English text')      -> translate a single string
 *   I18n.retranslate(root?)     -> manually re-scan a subtree
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'mnemosyne-dashboard-locale';
  var SUPPORTED = ['en', 'zh-CN'];
  var DEFAULT_LOCALE = 'en';
  // NOTE: 'value' is deliberately excluded — translating input values would
  // corrupt user input. Placeholders/aria-labels carry the UI text safely.
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];

  // Regex rules for templated strings that contain interpolated numbers
  // and therefore cannot be matched by exact dictionary keys. Each rule:
  // [RegExp, replacement] applied only after exact lookup misses.
  var PATTERNS = [
    [/^Tier (\d) after ([\d,]+) days$/, '第 $1 级 · $2 天后'],
    [/^Weights: hot (×[\d.]+) · warm (×[\d.]+) · cold (×[\d.]+)$/, '权重：热 $1 · 温 $2 · 冷 $3']
  ];

  /** Apply regex rules to a trimmed string; return translated or null. */
  function patternTranslate(trimmed) {
    for (var i = 0; i < PATTERNS.length; i++) {
      var m = trimmed.match(PATTERNS[i][0]);
      if (m) return trimmed.replace(PATTERNS[i][0], PATTERNS[i][1]);
    }
    return null;
  }

  var dict = {};          // active locale: { english: translation }
  var locale = DEFAULT_LOCALE;
  var observer = null;
  var translating = false; // reentrancy guard
  var suspended = false;   // pause observer during restore/retranslate
  // Remember the original English of every node/attribute we touched, so a
  // switch back to 'en' (or to another locale) can restore before retranslating.
  var originals = new WeakMap(); // node -> { nodeValue?, attrs?: {name: value} }
  var touched = [];              // parallel list of nodes we translated (WeakMap isn't iterable)

  function normalize(loc) {
    if (!loc) return DEFAULT_LOCALE;
    loc = String(loc);
    if (loc.toLowerCase().indexOf('zh') === 0) return 'zh-CN';
    return 'en';
  }

  function readSavedLocale() {
    try {
      return normalize(global.localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      return DEFAULT_LOCALE;
    }
  }

  function saveLocale(loc) {
    try { global.localStorage.setItem(STORAGE_KEY, loc); } catch (e) { /* private mode */ }
  }

  function loadDictionary(loc) {
    var url = '/static/locales/' + loc + '.json';
    return fetch(url, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('i18n dict load failed: ' + r.status);
        return r.json();
      })
      .catch(function () { return {}; }); // never break the dashboard over i18n
  }

  /** Translate one exact string. */
  function t(text) {
    if (text == null) return text;
    var key = String(text);
    var hit = dict[key];
    return hit === undefined || hit === '' ? text : hit;
  }

  function ensureRecord(node) {
    var rec = originals.get(node);
    if (!rec) {
      rec = {};
      originals.set(node, rec);
      touched.push(node);
    }
    return rec;
  }

  /** Translate a single text node in place, remembering its English source. */
  function translateTextNode(node) {
    if (!node.nodeValue) return;
    var raw = node.nodeValue;
    var trimmed = raw.trim();
    if (!trimmed || trimmed.length < 2) return;
    var rec = originals.get(node);
    // Compare against the remembered source (not the current value) so that
    // re-passes after a locale switch can retranslate the same node.
    var source = (rec && rec.nodeValue != null) ? rec.nodeValue : raw;
    var s = source.trim();
    var hit = dict[s];
    if (hit === undefined || hit === s) {
      // Fall back to regex rules (templated strings with numbers).
      if (locale !== 'zh-CN') return;
      var ph = patternTranslate(s);
      if (ph === null || ph === s) return;
      hit = ph;
    }
    if (!rec) rec = ensureRecord(node);
    if (rec.nodeValue == null) rec.nodeValue = raw;
    var lead = source.slice(0, source.indexOf(s));
    var tail = source.slice(source.indexOf(s) + s.length);
    node.nodeValue = lead + hit + tail;
  }

  /** Translate translatable attributes on an element (with originals). */
  function translateAttributes(el) {
    if (!el.attributes) return;
    var rec = originals.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var name = ATTRS[i];
      if (rec && rec.attrs && rec.attrs[name] != null && el.getAttribute(name) !== rec.attrs[name]) {
        // Attribute changed by the app (e.g. a real value update) — don't fight it.
        continue;
      }
      var val = el.getAttribute(name);
      if (!val) continue;
      var source = (rec && rec.attrs && rec.attrs[name] != null) ? rec.attrs[name] : val;
      var hit = dict[source];
      if (hit === undefined || hit === source) continue;
      if (!rec) rec = ensureRecord(el);
      if (!rec.attrs) rec.attrs = {};
      if (rec.attrs[name] == null) rec.attrs[name] = val;
      el.setAttribute(name, hit);
    }
  }

  /** Restore every node/attribute we previously translated back to English. */
  function restoreAll() {
    if (typeof WeakMap === 'undefined') return;
    // WeakMap is not iterable; we track touched nodes in a parallel array.
    for (var i = 0; i < touched.length; i++) {
      var node = touched[i];
      var rec = originals.get(node);
      if (!rec) continue;
      if (rec.nodeValue != null && node.nodeValue !== rec.nodeValue) {
        node.nodeValue = rec.nodeValue;
      }
      if (rec.attrs && node.attributes) {
        for (var name in rec.attrs) {
          if (Object.prototype.hasOwnProperty.call(rec.attrs, name)) {
            node.setAttribute(name, rec.attrs[name]);
          }
        }
      }
    }
    touched.length = 0;
  }

  /** Walk a DOM subtree and translate all text nodes + attributes. */
  function translateTree(root) {
    if (translating) return;
    translating = true;
    try {
      if (!root || !root.nodeType) return;
      // Element attributes
      if (root.nodeType === 1) {
        translateAttributes(root);
      }
      if (root.querySelectorAll) {
        var els = root.querySelectorAll('*');
        for (var i = 0; i < els.length; i++) translateAttributes(els[i]);
      }
      // Text nodes (TreeWalker)
      var walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
            var p = node.parentElement;
            if (p) {
              var tag = p.tagName;
              if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );
      var n;
      while ((n = walker.nextNode())) translateTextNode(n);
      // root itself may be a text node
      if (root.nodeType === 3) translateTextNode(root);
    } finally {
      translating = false;
    }
  }

  /** Watch for dynamically injected content (the app uses lots of innerHTML). */
  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (mutations) {
      if (translating || suspended) return;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType === 1 || node.nodeType === 3) translateTree(node);
        }
        if (m.type === 'attributes' && m.target && m.target.nodeType === 1) {
          translateAttributes(m.target);
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  function updateSwitcher() {
    var selects = document.querySelectorAll('[data-i18n-switch]');
    for (var i = 0; i < selects.length; i++) {
      selects[i].value = locale;
    }
    var labels = document.querySelectorAll('[data-i18n-current]');
    for (var k = 0; k < labels.length; k++) {
      labels[k].textContent = locale === 'zh-CN' ? '中文' : 'English';
    }
  }

  function applyHtmlLang() {
    document.documentElement.setAttribute('lang', locale);
  }

  /** Re-translate the whole document (used after locale switch). */
  function retranslate(root) {
    translateTree(root || document.documentElement);
  }

  function setLocale(loc) {
    loc = normalize(loc);
    return loadDictionary(loc).then(function (d) {
      suspended = true;
      try {
        // Restore original English first so the new dictionary can be applied
        // cleanly (also makes switching back to 'en' actually work).
        restoreAll();
        dict = d || {};
        locale = loc;
        saveLocale(loc);
        applyHtmlLang();
        updateSwitcher();
        retranslate();
      } finally {
        suspended = false;
      }
      // Ensure the observer is live even if setLocale() is called directly
      // without init() (startObserver is idempotent).
      startObserver();
      return loc;
    });
  }

  function init() {
    var saved = readSavedLocale();
    return setLocale(saved).then(function () {
      startObserver();
      // Some apps finish async rendering after DOMContentLoaded; a couple of
      // delayed passes catch content that arrived before the observer was up.
      setTimeout(function () { retranslate(); }, 300);
      setTimeout(function () { retranslate(); }, 1200);
      return locale;
    });
  }

  global.I18n = {
    init: init,
    setLocale: setLocale,
    getLocale: function () { return locale; },
    supported: SUPPORTED.slice(),
    t: t,
    retranslate: retranslate
  };

  // Auto-wire language switchers marked with data-i18n-switch on change.
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el && el.matches && el.matches('[data-i18n-switch]')) {
      setLocale(el.value);
    }
  });

  // Expose init for the host page to call; also auto-init on DOM ready.
  global.__I18N_AUTO_INIT__ = function () { init(); };
})(window);
