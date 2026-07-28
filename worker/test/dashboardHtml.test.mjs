import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DASHBOARD_HTML } from '../src/dashboardHtml.js';

class Element {
  constructor(id, attrs = {}) {
    this.id = id;
    this.attrs = attrs;
    this.events = {};
    this.style = {};
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.buttons = [];
    const names = new Set();
    this.classList = {
      toggle(name, on) { if (on) names.add(name); else names.delete(name); },
      contains(name) { return names.has(name); }
    };
  }

  getAttribute(name) { return this.attrs[name]; }
  addEventListener(type, handler) { (this.events[type] || (this.events[type] = [])).push(handler); }
  dispatch(type, event = {}) { (this.events[type] || []).forEach((handler) => handler.call(this, { key: '', ...event })); }
  querySelectorAll(selector) {
    if (selector === 'button') return this.buttons;
    return [];
  }
}

function dashboard(rows, storage) {
  const elements = {};
  ['range', 'gen', 'chips', 'chart', 'charttitle', 'legend', 'thead', 'tbody', 'rowcount', 'tip', 'clearf', 'csv'].forEach((id) => {
    elements[id] = new Element(id);
  });
  elements.range.value = 'all';
  elements.bucketseg = new Element('bucketseg');
  elements.metricseg = new Element('metricseg');
  elements.bucketseg.buttons = ['10m', 'hour', 'day'].map((value) => new Element('', { 'data-b': value }));
  elements.metricseg.buttons = ['hits', 'users'].map((value) => new Element('', { 'data-m': value }));

  const document = {
    getElementById(id) { return elements[id]; },
    createElement() { return new Element('a'); }
  };
  const sessionStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); }
  };
  const script = DASHBOARD_HTML.match(/<script>\n([\s\S]*)\n<\/script>/)[1];
  vm.runInNewContext(script, {
    Blob, Date, JSON, Object, Promise, String, URL, Math, Infinity,
    document, sessionStorage, location: { origin: 'https://analytics.test' },
    window: {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ rows, count: rows.length, generatedAt: Date.now() }) })
  });
  return elements;
}

const now = Date.now();
const rows = [
  { ts: now - 2 * 3600e3, visitor: 'one', human: 1, country: 'IL' },
  { ts: now - 5 * 3600e3, visitor: 'two', human: 1, country: 'US' },
  { ts: now - 7 * 3600e3, visitor: 'three', human: 1, country: 'DE' }
];
const storage = new Map();
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

let page = dashboard(rows, storage);
await settle();
page.range.value = '6h';
page.range.dispatch('change');
assert.equal(JSON.parse(storage.get('hhwi.analytics.dashboard.state.v1')).range, '6h');
assert.equal(page.rowcount.textContent, '2 of 3 rows', '6h ends at the current time, not the newest hit');
page.metricseg.buttons[1].dispatch('click');
page.bucketseg.buttons[2].dispatch('click');

page = dashboard(rows, storage);
await settle();
assert.equal(page.range.value, '6h');
assert.equal(page.metricseg.buttons[1].classList.contains('on'), true);
assert.equal(page.bucketseg.buttons[2].classList.contains('on'), true);
console.log('dashboard analytics state and range behavior passed');
