'use strict';
const crypto = require('crypto');
const { config } = require('./config');

const SELECTORS = {
  composer: ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]', 'textarea[data-id="root"]', 'div[contenteditable="true"][data-placeholder]', '[data-testid="prompt-textarea"]', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
  sendButton: [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]',
    'button[data-testid="fruitjuice-send-button"]',
    'button[aria-label*="Send"]',
    'form button[type="submit"]',
  ],
  newChat: [
    'a[data-testid="create-new-chat-button"]',
    'button[data-testid="create-new-chat-button"]',
    '[data-testid="create-new-chat-button"]',
    'button[aria-label="New chat"]',
    'a[aria-label="New chat"]',
    'button[aria-label="New Chat"]',
    'a[aria-label="New Chat"]',
    '[data-testid="new-chat-button"]',
    'nav a[href="/"]',
    'a[href="/?model="]',
    'a[href="/"]',
  ],
  plusButton: ['button[aria-label="Attach files"]', 'button[aria-label="Upload files and more"]', 'button[aria-label*="Attach"]', 'button[data-testid="composer-plus-btn"]'],
  loginButton: ['button[data-testid="login-button"]', 'button:has-text("Log in")', 'button:has-text("Sign up")'],
  userMenu: ['button[data-testid="profile-button"]', 'button[aria-label*="Open profile"]', 'nav button[aria-haspopup="menu"]'],
  userMessage: ['[data-message-author-role="user"]', 'div[data-message-author-role="user"]', 'div[data-testid*="user-message"]'],
};

class ChatGPTAdapter {
  constructor(page, logger) { this.page = page; this.log = logger || console; }
  async waitForAny(selectors, options) {
    options = options || {};
    const timeout = options.timeout || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (let i = 0; i < selectors.length; i++) {
        try {
          const el = await this.page.$(selectors[i]);
          if (el) {
            const visible = await el.isVisible().catch(function() { return false; });
            if (visible || options.allowHidden) return { element: el, selector: selectors[i] };
          }
        } catch (e) {}
      }
      await this.page.waitForTimeout(300);
    }
    return null;
  }
  async clickAny(selectors, options) {
    options = options || {};
    const found = await this.waitForAny(selectors, options);
    if (!found) return false;
    const el = found.element;
    try {
      await el.scrollIntoViewIfNeeded().catch(function () {});
      await el.click({ timeout: 5000 });
      return true;
    } catch (e) {}
    try { await el.click({ force: true, timeout: 3000 }); return true; } catch (e2) {}
    try {
      await el.evaluate(function (node) {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof node.click === 'function') node.click();
      });
      return true;
    } catch (e3) { return false; }
  }
  async isAuthenticated() {
    for (let i = 0; i < SELECTORS.loginButton.length; i++) {
      try {
        const el = await this.page.$(SELECTORS.loginButton[i]);
        if (el && await el.isVisible().catch(function() { return false; })) return false;
      } catch (e) {}
    }
    if (await this.waitForAny(SELECTORS.composer, { timeout: 10000 })) return true;
    if (await this.waitForAny(SELECTORS.userMenu, { timeout: 4000 })) return true;
    const history = await this.page.$('nav a[href*="/c/"]').catch(function() { return null; });
    return !!history;
  }
  async waitForComposer(timeout) {
    return this.waitForAny(SELECTORS.composer, { timeout: timeout || 20000 });
  }
  async isComposerUsable(timeout) {
    const found = await this.waitForComposer(timeout || 8000);
    if (!found) return null;
    try {
      const ok = await found.element.evaluate(function(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (el.getAttribute && el.getAttribute('contenteditable') === 'false') return false;
        if (el.disabled) return false;
        return true;
      });
      if (!ok) return null;
      return found;
    } catch (e) {
      return null;
    }
  }
  async openNewChat() {
    const target = config.chatgptNewChatUrl || config.chatgptUrl || 'https://chatgpt.com/';
    const before = await this.getConversationIdentity().catch(function() { return { url: null, conversationId: null }; });
    const beforeIsConversation = !!(before && before.conversationId) || /chatgpt\\.com\\/c\\//i.test((before && before.url) || '');
    if (!beforeIsConversation && await this.isComposerUsable(3000)) {
      this.log.info('Already on home/new-chat with usable composer');
      return true;
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      let acted = false;
      let currentUrl = '';
      try { currentUrl = this.page.url(); } catch (e) {}
      const currentIsConversation = /chatgpt\\.com\\/c\\//i.test(currentUrl);

      if (currentIsConversation) {
        try {
          const clicked = await this.clickAny(SELECTORS.newChat, { timeout: 6000 });
          if (clicked) {
            acted = true;
            this.log.info('New chat click attempt=' + attempt);
          }
        } catch (e) {
          this.log.warn('New chat click error: ' + e.message);
        }
      }

      if (!acted) {
        this.log.info('New chat via navigation attempt=' + attempt);
        try {
          await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
          acted = true;
        } catch (e) {
          this.log.warn('New chat navigation failed: ' + e.message);
        }
      }

      try { await this.page.waitForLoadState('networkidle', { timeout: 10000 }); } catch (e) {}
      await this.page.waitForTimeout(1200);
      try { await this.page.keyboard.press('Escape'); } catch (e) {}

      const usable = await this.isComposerUsable(12000);
      if (!usable) {
        this.log.warn('Composer not usable after new chat attempt=' + attempt);
        continue;
      }

      const after = await this.getConversationIdentity().catch(function() { return { url: null, conversationId: null }; });
      const sameConversation = !!before.conversationId && !!after.conversationId &&
        before.conversationId === after.conversationId;
      if (!sameConversation || !beforeIsConversation) {
        this.log.info('New chat established with usable composer attempt=' + attempt);
        return true;
      }

      this.log.warn('Composer exists but old conversation identity remains attempt=' + attempt);
      try {
        await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (e) {
        this.log.warn('Forced home navigation failed: ' + e.message);
      }
    }

    this.log.warn('openNewChat: no confirmed new-chat composer');
    return false;
  }
  async getComposerText() {
    const found = await this.waitForAny(SELECTORS.composer, { timeout: 5000 });
    if (!found) return null;
    try {
      return ((await found.element.evaluate(function(el) {
        if (el.tagName === 'TEXTAREA') return el.value;
        return el.innerText || el.textContent || '';
      })) || '').trim();
    } catch (e) { return null; }
  }
  async insertPrompt(prompt) {
    const found = await this.waitForComposer(15000);
    if (!found) throw new Error('Composer not found');
    await found.element.click({ clickCount: 3 }).catch(function() {});
    await this.page.keyboard.press('Control+A').catch(function() {});
    await this.page.keyboard.press('Backspace').catch(function() {});
    const tag = await found.element.evaluate(function(el) { return el.tagName; });
    if (tag === 'TEXTAREA') {
      await found.element.fill(prompt);
    } else {
      await found.element.focus();
      await this.page.evaluate(function(text) {
        const el = document.activeElement;
        if (!el) return;
        if (el.isContentEditable) { el.innerHTML = ''; el.textContent = ''; }
        try { document.execCommand('insertText', false, text); }
        catch (e) {
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        }
      }, prompt);
    }
    await this.page.waitForTimeout(300);
    let current = await this.getComposerText();
    if (!current || this.normalizePromptText(current) !== this.normalizePromptText(prompt)) {
      await found.element.click().catch(function() {});
      await this.page.evaluate(function(text) {
        const el = document.querySelector('#prompt-textarea') || document.querySelector('div.ProseMirror[contenteditable="true"]') || document.activeElement;
        if (!el) return;
        el.focus();
        if (el.tagName === 'TEXTAREA') { el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); return; }
        if (el.isContentEditable) {
          el.innerHTML = '';
          el.textContent = text;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
        }
      }, prompt);
      await this.page.waitForTimeout(200);
      current = await this.getComposerText();
    }
    return current;
  }
  _normalize(s) { return this.normalizePromptText(s); }
  normalizePromptText(s) {
    if (s == null) return '';
    let t = String(s);
    try { t = t.normalize('NFC'); } catch (e) {}
    t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    t = t.trim();
    t = t.replace(/[ \t\f\v]+/g, ' ');
    t = t.replace(/\n{3,}/g, '\n\n');
    return t;
  }
  async verifyPromptExact(expected) {
    const actual = await this.getComposerText();
    if (!actual) return false;
    const nExp = this.normalizePromptText(expected);
    const nAct = this.normalizePromptText(actual);
    return nAct === nExp;
  }
  async sendMessage() {
    const send = await this.waitForAny(SELECTORS.sendButton, { timeout: 8000 });
    if (send) {
      const disabled = await send.element.isDisabled().catch(function() { return false; });
      if (disabled) await this.page.waitForTimeout(1200);
      try { await send.element.click({ timeout: 5000 }); return 'click'; } catch (e) {}
      try { await send.element.click({ force: true, timeout: 3000 }); return 'force-click'; } catch (e2) {}
    }
    try { await this.page.keyboard.press('Control+Enter'); return 'ctrl-enter'; } catch (e3) {}
    await this.page.keyboard.press('Enter');
    return 'enter';
  }
  async getConversationIdentity() {
    const result = { url: null, conversationId: null, title: null };
    try {
      const url = this.page.url();
      result.url = url;
      const m = url.match(/chatgpt\.com\/c\/([A-Za-z0-9_:\-]+)/i);
      if (m) result.conversationId = m[1];
    } catch (e) {}
    try { result.title = await this.page.title(); } catch (e) {}
    try {
      const id = await this.page.evaluate(function() {
        const el = document.querySelector('[data-conversation-id]');
        if (el) return el.getAttribute('data-conversation-id');
        const active = document.querySelector('a[href*="/c/"][aria-current], nav a[href*="/c/"]');
        if (active) {
          const hm = (active.getAttribute('href') || '').match(/\/c\/([A-Za-z0-9_:\-]+)/);
          if (hm) return hm[1];
        }
        return null;
      });
      if (id && !result.conversationId) result.conversationId = id;
    } catch (e) {}
    return result;
  }
  async getVisibleUserTurns() {
    const self = this;
    const turns = await this.page.evaluate(function() {
      const nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
      const out = [];
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const style = window.getComputedStyle(n);
        const rect = n.getBoundingClientRect();
        const visible = style && style.display !== 'none' && style.visibility !== 'hidden'
          && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
        let inNav = false;
        let p = n.parentElement;
        while (p) {
          const tag = (p.tagName || '').toLowerCase();
          const role = p.getAttribute('role') || '';
          if (tag === 'nav' || role === 'navigation') { inNav = true; break; }
          p = p.parentElement;
        }
        if (inNav) continue;
        const text = (n.innerText || n.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        out.push({ text: text, visible: !!visible, index: i });
      }
      return out;
    }).catch(function() { return []; });
    return turns.map(function(t) {
      return { text: t.text, normalized: self.normalizePromptText(t.text), visible: t.visible, index: t.index };
    });
  }
  async getNewestVisibleUserTurn() {
    const turns = await this.getVisibleUserTurns();
    const visible = turns.filter(function(t) { return t.visible; });
    if (!visible.length) return null;
    return visible[visible.length - 1];
  }
  async verifySendPersisted(sentPrompt, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 55000;
    const expected = this.normalizePromptText(sentPrompt);
    const expectedHash = crypto.createHash('sha256').update(expected).digest('hex').slice(0, 16);
    const start = Date.now();
    const receipt = {
      expectedHash: expectedHash,
      conversationIdBefore: null,
      conversationUrlBefore: null,
      conversationIdAfter: null,
      conversationUrlAfter: null,
      matchedHash: null,
      newestTurnLength: null,
      reloadVerified: false,
      verifiedAt: null,
      reason: null,
    };
    const idBefore = await this.getConversationIdentity();
    receipt.conversationIdBefore = idBefore.conversationId;
    receipt.conversationUrlBefore = idBefore.url;
    let matched = false;
    while (Date.now() - start < timeout) {
      const newest = await this.getNewestVisibleUserTurn();
      if (newest && newest.visible) {
        receipt.newestTurnLength = newest.normalized.length;
        if (newest.normalized === expected) {
          matched = true;
          receipt.matchedHash = crypto.createHash('sha256').update(newest.normalized).digest('hex').slice(0, 16);
          this.log.info('verifySend: exact newest-user match hash=' + receipt.matchedHash);
          break;
        }
      }
      await this.page.waitForTimeout(700);
    }
    if (!matched) {
      receipt.reason = 'newest_user_turn_not_exact_match';
      return { ok: false, reason: receipt.reason, receipt: receipt };
    }
    const idMid = await this.getConversationIdentity();
    if (!idMid.conversationId && !idMid.url) {
      receipt.reason = 'no_conversation_identity_after_send';
      return { ok: false, reason: receipt.reason, receipt: receipt };
    }
    receipt.conversationIdAfter = idMid.conversationId;
    receipt.conversationUrlAfter = idMid.url;
    const reloadTarget = idMid.url && /chatgpt\.com\/c\//i.test(idMid.url)
      ? idMid.url
      : (idMid.conversationId ? ('https://chatgpt.com/c/' + idMid.conversationId) : null);
    if (!reloadTarget) {
      receipt.reason = 'no_stable_conversation_url_for_reload';
      return { ok: false, reason: receipt.reason, receipt: receipt };
    }
    try {
      await this.page.goto(reloadTarget, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await this.page.waitForTimeout(2500);
      const reloadDeadline = Date.now() + 25000;
      let reloadMatch = false;
      while (Date.now() < reloadDeadline) {
        const idAfter = await this.getConversationIdentity();
        const sameId = (idMid.conversationId && idAfter.conversationId && idMid.conversationId === idAfter.conversationId)
          || (idMid.url && idAfter.url && idMid.url.split('?')[0] === idAfter.url.split('?')[0]);
        if (!sameId) { await this.page.waitForTimeout(800); continue; }
        const newest = await this.getNewestVisibleUserTurn();
        if (newest && newest.visible && newest.normalized === expected) {
          reloadMatch = true;
          receipt.reloadVerified = true;
          receipt.conversationIdAfter = idAfter.conversationId || receipt.conversationIdAfter;
          receipt.conversationUrlAfter = idAfter.url || receipt.conversationUrlAfter;
          break;
        }
        await this.page.waitForTimeout(800);
      }
      if (!reloadMatch) {
        receipt.reason = 'reload_persistence_failed';
        return { ok: false, reason: receipt.reason, receipt: receipt };
      }
    } catch (e) {
      receipt.reason = 'reload_error:' + (e && e.message ? e.message : String(e));
      return { ok: false, reason: receipt.reason, receipt: receipt };
    }
    receipt.verifiedAt = new Date().toISOString();
    receipt.reason = 'ok';
    return { ok: true, reason: 'ok', receipt: receipt };
  }
  async verifyUserMessageAppeared(promptSnippet, timeout) {
    const result = await this.verifySendPersisted(promptSnippet, { timeout: timeout || 50000 });
    return !!result.ok;
  }
  async getConversationUrl() {
    const id = await this.getConversationIdentity();
    if (id.url && /chatgpt\.com\/c\//i.test(id.url)) return id.url;
    return null;
  }
  async detectPageState() {
    const url = this.page.url();
    try {
      const title = await this.page.title();
      if (/just a moment|verif(y|ying).{0,20}human|attention required/i.test(title || '')) return 'CLOUDFLARE';
    } catch (_) {}
    if (url.includes('/auth') || url.includes('login.openai') || url.includes('accounts.google')) return 'AUTH_PAGE';
    if (!(await this.isAuthenticated())) return 'NOT_AUTHENTICATED';
    if (await this.waitForAny(SELECTORS.composer, { timeout: 3000 })) return 'COMPOSER_PRESENT';
    return 'UNKNOWN';
  }
}
module.exports = { ChatGPTAdapter, SELECTORS };
