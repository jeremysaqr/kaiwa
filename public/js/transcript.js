/**
 * public/js/transcript.js
 *
 * The live conversation view.
 *
 * Two responsibilities that the spec calls out specifically:
 *
 *  1. RAW vs DISPLAY (PART 21). Every message keeps the original transcript
 *     text. The romanised form is only ever computed for rendering, so memory
 *     extraction still receives real Japanese.
 *
 *  2. AUTOSCROLL (PART 23, BUG 4). New messages AND streaming deltas must stay
 *     visible without the user touching the scrollbar. Handled with a pinned
 *     flag, rAF-batched scrolling, a MutationObserver as a backstop, and CSS
 *     scroll-anchoring disabled.
 */

import { toDisplayText } from '../shared/romaji.js';

/** Distance from the bottom, in px, still counted as "at the bottom". */
const PIN_THRESHOLD = 80;

export class TranscriptView {
  /**
   * @param {{container: HTMLElement, jumpButton?: HTMLElement|null, emptyState?: HTMLElement|null}} elements
   */
  constructor({ container, jumpButton = null, emptyState = null }) {
    if (!container) throw new Error('TranscriptView requires a container element.');

    this.container = container;
    this.jumpButton = jumpButton;
    this.emptyState = emptyState;

    /** Raw, unmodified turns — this is what memory extraction consumes. */
    /** @type {{role: 'user'|'assistant', text: string, at: string}[]} */
    this.raw = [];

    /** Live message bubbles, keyed by the Realtime item id. */
    /** @type {Map<string, {el: HTMLElement, textEl: HTMLElement, role: string, text: string}>} */
    this.bubbles = new Map();

    this.language = 'German';
    this.pinned = true;
    this.scrollQueued = false;

    this.container.addEventListener('scroll', () => this.handleScroll(), { passive: true });

    // Backstop: if anything at all changes inside the container while we are
    // pinned, scroll again on the next frame. This covers streamed text nodes
    // that do not trigger our own append path.
    this.observer = new MutationObserver(() => {
      if (this.pinned) this.scheduleScroll();
    });
    this.observer.observe(this.container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    this.jumpButton?.addEventListener('click', () => {
      this.pinned = true;
      this.scrollToBottom(true);
      this.updateJumpButton();
    });

    this.updateJumpButton();
  }

  /** @param {string} language */
  setLanguage(language) {
    this.language = String(language || '');
    // Re-render existing bubbles: switching profile mid-view must not leave
    // Japanese script on screen.
    for (const bubble of this.bubbles.values()) {
      bubble.textEl.textContent = toDisplayText(bubble.text, this.language);
    }
  }

  // -- Scrolling ------------------------------------------------------------

  handleScroll() {
    const { scrollTop, scrollHeight, clientHeight } = this.container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    this.pinned = distanceFromBottom <= PIN_THRESHOLD;
    this.updateJumpButton();
  }

  updateJumpButton() {
    if (!this.jumpButton) return;
    const hasContent = this.bubbles.size > 0;
    this.jumpButton.hidden = this.pinned || !hasContent;
  }

  /** Batch scroll requests into one per animation frame. */
  scheduleScroll() {
    if (this.scrollQueued) return;
    this.scrollQueued = true;
    requestAnimationFrame(() => {
      this.scrollQueued = false;
      if (this.pinned) this.scrollToBottom(false);
    });
  }

  /** @param {boolean} smooth */
  scrollToBottom(smooth) {
    const target = this.container.scrollHeight - this.container.clientHeight;
    if (smooth && typeof this.container.scrollTo === 'function') {
      this.container.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      this.container.scrollTop = this.container.scrollHeight;
    }
  }

  // -- Rendering ------------------------------------------------------------

  /**
   * @param {'user'|'assistant'|'system'} role
   * @returns {{el: HTMLElement, textEl: HTMLElement}}
   */
  createBubble(role) {
    const wrapper = document.createElement('div');
    wrapper.className = `msg msg--${role}`;

    const label = document.createElement('div');
    label.className = 'msg__who';
    label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'Tutor' : 'System';

    const text = document.createElement('div');
    text.className = 'msg__text';

    wrapper.append(label, text);
    return { el: wrapper, textEl: text };
  }

  hideEmptyState() {
    if (this.emptyState && !this.emptyState.hidden) this.emptyState.hidden = true;
  }

  /**
   * Append to (or create) the streaming bubble for `itemId`.
   * @param {'user'|'assistant'} role
   * @param {string} itemId
   * @param {string} delta
   */
  appendDelta(role, itemId, delta) {
    if (!delta) return;
    const key = `${role}:${itemId}`;
    let bubble = this.bubbles.get(key);

    if (!bubble) {
      const { el, textEl } = this.createBubble(role);
      el.classList.add('msg--streaming');
      this.container.append(el);
      bubble = { el, textEl, role, text: '' };
      this.bubbles.set(key, bubble);
      this.hideEmptyState();
    }

    bubble.text += delta;
    bubble.textEl.textContent = toDisplayText(bubble.text, this.language);
    this.scheduleScroll();
    this.updateJumpButton();
  }

  /**
   * Finalise a turn: replace the streamed text with the authoritative
   * transcript and record the RAW text for memory extraction.
   *
   * @param {'user'|'assistant'} role
   * @param {string} itemId
   * @param {string} text
   */
  completeMessage(role, itemId, text) {
    const key = `${role}:${itemId}`;
    let bubble = this.bubbles.get(key);
    const finalText = String(text ?? '').trim();

    if (!bubble) {
      if (!finalText) return;
      const { el, textEl } = this.createBubble(role);
      this.container.append(el);
      bubble = { el, textEl, role, text: '' };
      this.bubbles.set(key, bubble);
      this.hideEmptyState();
    }

    if (finalText) bubble.text = finalText;
    bubble.el.classList.remove('msg--streaming');
    bubble.textEl.textContent = toDisplayText(bubble.text, this.language);

    if (bubble.text.trim()) {
      this.raw.push({
        role: role === 'user' ? 'user' : 'assistant',
        text: bubble.text.trim(),
        at: new Date().toISOString(),
      });
    }

    this.scheduleScroll();
    this.updateJumpButton();
  }

  /**
   * A system notice inside the conversation flow (errors, session boundaries).
   * Never added to the raw transcript.
   * @param {string} message
   * @param {'info'|'error'|'success'} [tone]
   */
  addSystemNote(message, tone = 'info') {
    const { el, textEl } = this.createBubble('system');
    el.classList.add(`msg--${tone}`);
    textEl.textContent = message;
    this.container.append(el);
    this.hideEmptyState();
    this.scheduleScroll();
  }

  /** Drop every bubble and every raw turn. Used when a new call starts. */
  clear() {
    this.bubbles.clear();
    this.raw = [];
    this.container.replaceChildren();
    if (this.emptyState) {
      this.container.append(this.emptyState);
      this.emptyState.hidden = false;
    }
    this.pinned = true;
    this.updateJumpButton();
  }

  /**
   * The RAW transcript, in original script, for the memory extractor.
   * @returns {{role: string, text: string, at: string}[]}
   */
  getRawTranscript() {
    return this.raw.map((entry) => ({ ...entry }));
  }

  /** @returns {boolean} */
  hasContent() {
    return this.raw.length > 0;
  }

  /** Release the observer. */
  destroy() {
    this.observer.disconnect();
  }
}
