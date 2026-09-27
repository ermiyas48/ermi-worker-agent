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
    'nav a[href="/"]',
    'a[href="/?model="]',
    'a[href="/"]',
  ],
  plusButton: ['button[aria-label="Attach files"]', 'button[aria-label="Upload files and more"]', 'button[aria-label*="Attach"]', 'button[data-testid="composer-plus-btn"]', 'button[aria-haspopup="menu"]'],
  loginButton: ['button[data-testid="login-button"]', 'button:has-text("Log in")', 'button:has-text("Sign up")', 'a[href*="auth"]'],
  userMenu: ['button[data-testid="profile-button"]', 'button[aria-label*="Open profile"]', 'button[id*="radix"] img', 'nav button[aria-haspopup="menu"]'],
  userMessage: [
    '[data-message-author-role="user"]',
    'div[data-message-author-role="user"]',
    'div[data-testid*="user-message"]',
    '[data-testid="conversation-turn-"] [data-message-author-role="user"]',
    'article[data-testid*="conversation-turn"]',
    'div.agent-turn',
  ],
  pluginsOption: ['div[role="menuitem"]:has-text("Plugins")', 'button:has-text("Plugins")', 'div[role="option"]:has-text("Plugins")'],
  thinkingOption: ['div[role="menuitem"]:has-text("Thinking")', 'button:has-text("Thinking")', 'div[role="menuitem"]:has-text("Reasoning")', 'button:has-text("Reason")', 'div[role="option"]:has-text("Thinking")'],
  toolsMenu: ['button[aria-label*="Model"]', 'button[aria-label*="GPT"]', 'button:has-text("GPT")', 'button[data-testid="model-switcher"]'],
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
    const sel = found.selector;
    try {
      await el.scrollIntoViewIfNeeded().catch(function () {});
      await el.click({ timeout: 5000 });
      return true;
    } catch (e) {
      this.log.warn('Click intercepted on ' + sel + ': ' + e.message);
    }
    try {
      await el.click({ force: true, timeout: 3000 });
      return true;
    } catch (e2) {
      this.log.warn('Force click failed on ' + sel + ': ' + e2.message);
    }
    try {
      await el.evaluate(function (node) {
        node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        if (typeof node.click === 'function') node.click();
      });
      return true;
    } catch (e3) {
      this.log.warn('DOM click failed on ' + sel + ': ' + e3.message);
    }
    return false;
  }
  async isAuthenticated() {
    for (let i = 0; i < SELECTORS.loginButton.length; i++) {
      try {
        const el = await this.page.$(SELECTORS.loginButton[i]);
        if (el && await el.isVisible().catch(function() { return false; })) return false;
      } catch (e) {}
    }
    const composer = await this.waitForAny(SELECTORS.composer, { timeout: 10000 });
    if (composer) return true;
    const menu = await this.waitForAny(SELECTORS.userMenu, { timeout: 4000 });
    if (menu) return true;
    const history = await this.page.$('[data-testid="history"], nav a[href*="/c/"]').catch(function() { return null; });
    if (history) return true;
    return false;
  }
  async ensureOnChatGPT() {
    const url = this.page.url();
    if (!url.includes('chatgpt.com') && !url.includes('openai.com')) {
      await this.page.goto(config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.page.waitForTimeout(2000);
    }
  }
  async waitForComposer(timeout) {
    return this.waitForAny(SELECTORS.composer, { timeout: timeout || 20000 });
  }
  async openNewChat() {
    const target = config.chatgptNewChatUrl || config.chatgptUrl || 'https://chatgpt.com/';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = this.page.url();
      let acted = false;
      if (/chatgpt\.com/i.test(current)) {
        const clicked = await this.clickAny(SELECTORS.newChat, { timeout: 6000 });
        if (clicked) { acted = true; this.log.info('New chat click attempt=' + attempt); }
      }
      if (!acted) {
        this.log.info('New chat via navigation attempt=' + attempt);
        await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
        acted = true;
      }
      await this.page.waitForTimeout(800);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(function () {});
      try { await this.page.keyboard.press('Escape'); } catch (e) {}
      const composer = await this.waitForComposer(8000);
      if (composer) {
        this.log.info('Composer ready after new chat attempt=' + attempt);
        return true;
      }
      this.log.warn('Composer not ready after new chat attempt=' + attempt);
    }
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
    await this.page.waitForTimeout(400);
    const current = await this.getComposerText();
    if (!current || this._normalize(current).indexOf(this._normalize(prompt).slice(0, 80)) === -1) {
      await found.element.click();
      await this.page.keyboard.type(prompt, { delay: 5 });
    }
    return this.getComposerText();
  }
  _normalize(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
  async verifyPromptExact(expected) {
    const actual = await this.getComposerText();
    if (!actual) return false;
    const nExp = this._normalize(expected);
    const nAct = this._normalize(actual);
    return nAct === nExp || nAct.indexOf(nExp.slice(0, 120)) !== -1;
  }
  async openPlusMenu() {
    const clicked = await this.clickAny(SELECTORS.plusButton, { timeout: 8000 });
    if (!clicked) { this.log.warn('Plus button not found'); return false; }
    await this.page.waitForTimeout(600);
    return true;
  }
  async selectPluginsIfAvailable() {
    const found = await this.waitForAny(SELECTORS.pluginsOption, { timeout: 4000 });
    if (found) { await found.element.click().catch(function() {}); await this.page.waitForTimeout(400); return true; }
    return false;
  }
  async selectThinkingIfAvailable() {
    const found = await this.waitForAny(SELECTORS.thinkingOption, { timeout: 4000 });
    if (found) { await found.element.click().catch(function() {}); await this.page.waitForTimeout(400); return true; }
    return false;
  }
  async sendMessage() {
    const send = await this.waitForAny(SELECTORS.sendButton, { timeout: 8000 });
    if (send) {
      const disabled = await send.element.isDisabled().catch(function() { return false; });
      if (disabled) await this.page.waitForTimeout(1200);
      try { await send.element.click({ timeout: 5000 }); return 'click'; } catch (e) { this.log.warn('Send click failed: ' + e.message); }
      try { await send.element.click({ force: true, timeout: 3000 }); return 'force-click'; } catch (e2) {}
    }
    try { await this.page.keyboard.press('Control+Enter'); return 'ctrl-enter'; } catch (e3) {}
    await this.page.keyboard.press('Enter');
    return 'enter';
  }
  async _collectUserText() {
    return this._normalize(await this.page.evaluate(function() {
      const parts = [];
      const sels = ['[data-message-author-role="user"]', 'div[data-message-author-role="user"]', '[data-testid*="user-message"]', 'article[data-turn="user"]'];
      for (let s = 0; s < sels.length; s++) {
        const nodes = document.querySelectorAll(sels[s]);
        for (let i = 0; i < nodes.length; i++) parts.push(nodes[i].innerText || nodes[i].textContent || '');
      }
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
      if (snippet && body.indexOf(snippet) !== -1) {
        this.log.info('verifyUserMessage: matched snippet in user bubble');
        return true;
      }
      if (body.indexOf(marker) !== -1) {
        this.log.info('verifyUserMessage: matched ERMI marker');
        return true;
      }
      const composerText = await this.getComposerText();
      const composerEmpty = composerText !== null && this._normalize(composerText).length < 8;
      if (composerEmpty) sawEmptyComposer = true;
      const assistant = await this.page.evaluate(function() {
        return document.querySelectorAll('[data-message-author-role="assistant"]').length;
      }).catch(function() { return 0; });
      if (sawEmptyComposer && assistant > 0) {
        this.log.info('verifyUserMessage: empty composer + assistant reply');
        return true;
      }
      const url = this.page.url();
      if (/chatgpt\.com\/c\//i.test(url) && sawEmptyComposer && (body.length > 30 || assistant > 0)) {
        this.log.info('verifyUserMessage: conversation URL + activity');
        return true;
      }
      await this.page.waitForTimeout(700);
    }
    this.log.warn('verifyUserMessage: no hard evidence of submitted message');
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
    const authed = await this.isAuthenticated();
    if (!authed) return 'NOT_AUTHENTICATED';
    const composer = await this.waitForAny(SELECTORS.composer, { timeout: 3000 });
    if (composer) return 'COMPOSER_PRESENT';
    return 'UNKNOWN';
  }
}
module.exports = { ChatGPTAdapter, SELECTORS };
