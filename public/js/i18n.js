const I18n = {
  locale: 'bn',
  strings: {},

  async init() {
    this.locale = localStorage.getItem('ob_lang') || 'bn';
    await this.load(this.locale);
    this.applyDOM();
    document.querySelectorAll('.lang-btn').forEach(b => {
      b.addEventListener('click', () => this.switch(b.dataset.lang));
    });
  },

  async load(locale) {
    try {
      const res = await fetch(`/locales/${locale}.json`);
      this.strings = await res.json();
    } catch {
      const res = await fetch('/locales/bn.json');
      this.strings = await res.json();
      locale = 'bn';
    }
    this.locale = locale;
    document.documentElement.lang = locale === 'bn' ? 'bn' : 'en';
    document.documentElement.dir = 'ltr';
    localStorage.setItem('ob_lang', locale);
  },

  t(key, params) {
    const str = key.split('.').reduce((o, k) => o?.[k], this.strings);
    if (str === undefined || str === null) return key;
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  },

  applyDOM() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (el.tagName === 'TITLE') {
        el.textContent = this.t(key);
      } else {
        el.innerHTML = this.t(key);
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-value]').forEach(el => {
      el.value = this.t(el.dataset.i18nValue);
    });
  },

  async switch(locale) {
    await this.load(locale);
    this.applyDOM();
    document.querySelectorAll('.lang-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.lang === locale);
    });
    if (window.__onLangChange) window.__onLangChange(locale);
  }
};

const __ = (key, params) => I18n.t(key, params);
