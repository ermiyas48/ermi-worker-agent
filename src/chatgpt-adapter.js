'use strict';
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
  ],
  plusButton: ['button[aria-label="Attach files"]', 'button[aria-label="Upload files and more"]', 'button[aria-label*="Attach"]', 'button[data-testid="composer-plus-btn"]'],
  loginButton: ['button[data-testid="login-button"]', 'button:has-text("Log in")', 'button:has-text("Sign up")'],
  userMenu: ['button[data-testid="profile-button"]', 'button[aria-label*="Open profile"]', 'nav button[aria-haspopup="menu"]'],
  userMessage: ['[data-message-author-role="user"]', 'div[data-message-author-role="user"]', 'div[data-testid*="user-message"]'],
  pluginsOption: ['div[role="menuitem"]:has-text("Plugins")', 'button:has-text("Plugins")'],
  thinkingOption: ['div[role="menuitem"]:has-text("Thinking")', 'button:has-text("Thinking")'],
  toolsMenu: ['button[aria-label*="Model"]', 'button[aria-label*="GPT"]'],
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
  async openNewChat() {
    const already = await this.waitForComposer(4000);
    if (already) {
      const clicked = await this.clickAny(SELECTORS.newChat, { timeout: 3000 });
      if (clicked) {
        await this.page.waitForTimeout(1000);
        try { await this.page.keyboard.press('Escape'); } catch (e) {}
      }
      if (await this.waitForComposer(8000)) return true;
      this.log.info('Keeping pre-existing composer');
      return true;
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      const clicked = await this.clickAny(SELECTORS.newChat, { timeout: 5000 });
      if (clicked) {
        this.log.info('New chat click attempt=' + attempt);
        await this.page.waitForTimeout(1200);
        try { await this.page.keyboard.press('Escape'); } catch (e) {}
        if (await this.waitForComposer(10000)) return true;
      }
    }
    if (await this.waitForComposer(5000)) return true;
    await this.page.goto(config.chatgptUrl || 'https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(function () {});
    await this.page.waitForTimeout(1500);
    return !!(await this.waitForComposer(12000));
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
    if (!current || this._normalize(current).indexOf(this._normalize(prompt).slice(0, 60)) === -1) {
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
  _normalize(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  async verifyPromptExact(expected) {
    const actual = await this.getComposerText();
    if (!actual) return false;
    const nExp = this._normalize(expected);
    const nAct = this._normalize(actual);
    return nAct === nExp || nAct.indexOf(nExp.slice(0, 120)) !== -1;
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
  async _collectUserText() {
    return this._normalize(await this.page.evaluate(function() {
      const parts = [];
      document.querySelectorAll('[data-message-author-role="user"]').forEach(function(n) {
        parts.push(n.innerText || n.textContent || '');
      });
      return parts.join('\n');
    }).catch(function() { return ''; }));
  }
  async verifyUserMessageAppeared(promptSnippet, timeout) {
    timeout = timeout || 45000;
    const start = Date.now();
    const nPrompt = this._normalize(promptSnippet);
    const snippet = nPrompt.slice(0, 40);
    const marker = 'ERMI Worker Agent';
    let sawEmptyComposer = false;
    while (Date.now() - start < timeout) {
      const body = await this._collectUserText();
      if (snippet && body.indexOf(snippet) !== -1) return true;
      if (body.indexOf(marker) !== -1) return true;
      const composerText = await this.getComposerText();
      if (composerText !== null && this._normalize(composerText).length < 8) sawEmptyComposer = true;
      const assistant = await this.page.evaluate(function() {
        return document.querySelectorAll('[data-message-author-role="assistant"]').length;
      }).catch(function() { return 0; });
      if (sawEmptyComposer && assistant > 0) return true;
      const url = this.page.url();
      if (/chatgpt\.com\/c\//i.test(url) && sawEmptyComposer && (body.length > 30 || assistant > 0)) return true;
      await this.page.waitForTimeout(700);
    }
    return false;
  }
  async getConversationUrl() {
    try {
      const url = this.page.url();
      if (/chatgpt\.com\/c\//i.test(url)) return url;
    } catch (e) {}
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
