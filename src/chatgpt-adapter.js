'use strict';
const { config } = require('./config');

const SELECTORS = {
  composer: ['#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]', 'textarea[data-id="root"]', 'div[contenteditable="true"][data-placeholder]', '[data-testid="prompt-textarea"]', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
  sendButton: ['button[data-testid="send-button"]', 'button[aria-label="Send prompt"]', 'button[aria-label="Send message"]', 'button[data-testid="fruitjuice-send-button"]', 'button[aria-label*="Send"]'],
  newChat: ['a[data-testid="create-new-chat-button"]', 'button[aria-label="New chat"]', 'a[aria-label="New chat"]', '[data-testid="new-chat-button"]', 'a[href="/"]'],
  plusButton: ['button[aria-label="Attach files"]', 'button[aria-label="Upload files and more"]', 'button[aria-label*="Attach"]', 'button[data-testid="composer-plus-btn"]', 'button[aria-haspopup="menu"]'],
  loginButton: ['button[data-testid="login-button"]', 'button:has-text("Log in")', 'button:has-text("Sign up")', 'a[href*="auth"]'],
  userMenu: ['button[data-testid="profile-button"]', 'button[aria-label*="Open profile"]', 'button[id*="radix"] img', 'nav button[aria-haspopup="menu"]'],
  userMessage: ['[data-message-author-role="user"]', 'div[data-testid*="user-message"]'],
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
    const found = await this.waitForAny(selectors, options);
    if (!found) return false;
    try { await found.element.click({ timeout: 5000 }); return true; }
    catch (e) {
      this.log.warn('Click failed on ' + found.selector + ': ' + e.message);
      try { await found.element.click({ force: true, timeout: 3000 }); return true; } catch (e2) { return false; }
    }
  }
  async isAuthenticated() {
    for (let i = 0; i < SELECTORS.loginButton.length; i++) {
      try {
        const el = await this.page.$(SELECTORS.loginButton[i]);
        if (el && (await el.isVisible().catch(function() { return false; }))) {
          const text = (await el.textContent().catch(function() { return ''; })) || '';
          if (/log\s*in|sign\s*up|sign\s*in/i.test(text)) return false;
        }
      } catch (e) {}
    }
    const user = await this.waitForAny(SELECTORS.userMenu, { timeout: 4000, allowHidden: true });
    if (user) return true;
    const composer = await this.waitForAny(SELECTORS.composer, { timeout: 3000 });
    if (composer) {
      const url = this.page.url();
      if (url.includes('/auth') || url.includes('login')) return false;
      return true;
    }
    return false;
  }
  async openNewChat() {
    const current = this.page.url();
    if (!current.match(/chatgpt\.com\/?(\?|$)/) && current.indexOf('/c/') === -1) {
      await this.page.goto(config.chatgptNewChatUrl || config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      const clicked = await this.clickAny(SELECTORS.newChat, { timeout: 5000 });
      if (!clicked) await this.page.goto(config.chatgptNewChatUrl || config.chatgptUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(function() {});
    return true;
  }
  async waitForComposer(timeout) { return this.waitForAny(SELECTORS.composer, { timeout: timeout || 20000 }); }
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
    this.log.info('Plugins option not visible');
    return false;
  }
  async selectThinkingIfAvailable() {
    const found = await this.waitForAny(SELECTORS.thinkingOption, { timeout: 4000 });
    if (found) { await found.element.click().catch(function() {}); await this.page.waitForTimeout(400); return true; }
    const tools = await this.waitForAny(SELECTORS.toolsMenu, { timeout: 3000 });
    if (tools) {
      await tools.element.click().catch(function() {});
      await this.page.waitForTimeout(500);
      const think = await this.waitForAny(SELECTORS.thinkingOption, { timeout: 3000 });
      if (think) { await think.element.click().catch(function() {}); return true; }
    }
    this.log.info('Thinking option not found');
    return false;
  }
  async sendMessage() {
    const send = await this.waitForAny(SELECTORS.sendButton, { timeout: 8000 });
    if (!send) { await this.page.keyboard.press('Enter'); return 'keyboard'; }
    const disabled = await send.element.isDisabled().catch(function() { return false; });
    if (disabled) await this.page.waitForTimeout(1000);
    await send.element.click({ timeout: 5000 });
    return 'click';
  }
  async verifyUserMessageAppeared(promptSnippet, timeout) {
    timeout = timeout || 20000;
    const start = Date.now();
    const snippet = this._normalize(promptSnippet).slice(0, 60);
    while (Date.now() - start < timeout) {
      const body = this._normalize(await this.page.evaluate(function() {
        const nodes = document.querySelectorAll('[data-message-author-role="user"]');
        return Array.from(nodes).map(function(n) { return n.innerText; }).join(' ');
      }).catch(function() { return ''; }));
      if (body.indexOf(snippet) !== -1 || body.indexOf('ERMI Worker Agent') !== -1) return true;
      await this.page.waitForTimeout(500);
    }
    return false;
  }
  async detectPageState() {
    const url = this.page.url();
    if (url.includes('/auth') || url.includes('login.openai') || url.includes('accounts.google')) return 'AUTH_PAGE';
    const authed = await this.isAuthenticated();
    if (!authed) return 'NOT_AUTHENTICATED';
    const composer = await this.waitForAny(SELECTORS.composer, { timeout: 3000 });
    if (composer) return 'COMPOSER_PRESENT';
    return 'UNKNOWN';
  }
}
module.exports = { ChatGPTAdapter, SELECTORS };
