/* =====================================================================
   ObsiBook v3.0 — Instant-Speed Indexed Study & Vault Explorer Engine
   ===================================================================== */

const state = {
  library: null,
  currentView: 'dashboard', // 'dashboard' | 'folder' | 'doc'
  currentFolderPath: '',
  currentDoc: null,

  // Two-Tier Client-Side Document & Image Cache (L1 RAM Map + L2 IndexedDB / CacheStorage)
  docCache: new Map(), // docPath -> full doc object
  assetBlobUrlMap: new Map(), // '/api/asset?path=...' -> 'blob:...' (0ms RAM Image URL)
  assetFetchInFlight: new Map(),
  prefetchInFlight: new Map(),
  preloadedImages: new Set(),
  preloaderRunning: false,
  cachedHeadingEls: [],
  scrollRafPending: false,
  openRequestSeq: 0,

  // Navigation History Stack (for Back / Forward buttons & Browser popstate)
  navHistory: [{ type: 'dashboard' }],
  navIndex: 0,
  suppressHistoryPush: false,

  // Multi-Tab Open Documents (like Obsidian Tabs)
  openTabs: [], // [{ path, title, folder }]

  // Sidebar & Right Panel State
  sidebarTab: 'folders', // 'folders' | 'bookmarks' | 'tags'
  rightTab: 'toc',       // 'toc' | 'note' | 'hl'
  expandedFolders: new Set(),
  searchQuery: '',
  activeTagFilter: '',

  // Reading Scroll & Progress State
  currentScrollPercent: 0,
  currentScrollTop: 0,
  currentHeadingId: '',
  currentHeadingText: '',
  saveTimer: null,
  studyNoteTimer: null,
  lastReadTick: Date.now(),
  suppressScrollSave: false,

  // Bookmark & Selection Highlight State
  selectedBmColor: 'amber',
  pendingBmTarget: null,
  pendingSelectionText: '',

  // Active Recall Cloze Mode State
  clozeActive: false,
  clozeTotal: 0,
  clozeRevealedCount: 0,

  // Flashcard Modal State
  flashcards: [],
  flashcardIdx: 0,
  flashcardFlipped: false,

  // Pomodoro Timer State
  pomoSecondsLeft: 25 * 60,
  pomoTotalSeconds: 25 * 60,
  pomoModeLabel: '집중 25분',
  pomoRunning: false,
  pomoTimerId: null,

  // Typography & Eye-Comfort Settings
  settings: {
    theme: 'warm_paper',
    fontFamily: 'ridi',
    fontSize: 18,
    lineHeight: 1.9,
    paraSpacing: 1.3,
    maxWidth: '820px',
    viewMode: 'scroll',
    eyeCareFilter: 0,
    showSubtitle: true,
    autoRestoreScroll: true,
    zenMode: false,
  },

  // Paginated & TTS State
  chapterElements: [],
  currentChapterIdx: 0,
  ttsActive: false,
  ttsQueue: [],
  ttsIndex: 0,
};

/* =========================================================
   Browser IndexedDB Persistent Cache (L2 Instant Cache)
   ========================================================= */
const ObsiBookIDB = {
  dbPromise: null,
  open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      const req = window.indexedDB.open('ObsiBookFastCache_v4', 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
        if (!db.objectStoreNames.contains('docs')) {
          db.createObjectStore('docs', { keyPath: 'path' });
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = () => resolve(null);
    });
    return this.dbPromise;
  },
  async getLibrarySnapshot() {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('meta', 'readonly');
        const req = tx.objectStore('meta').get('library_v4');
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  },
  async saveLibrarySnapshot(libData) {
    const db = await this.open();
    if (!db) return;
    try {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(libData, 'library_v4');
    } catch {
      // Ignore quota errors
    }
  },
  async getAllCachedDocs() {
    const db = await this.open();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('docs', 'readonly');
        const req = tx.objectStore('docs').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  },
  async saveDocsBatch(docs) {
    if (!docs || docs.length === 0) return;
    const db = await this.open();
    if (!db) return;
    try {
      const tx = db.transaction('docs', 'readwrite');
      const store = tx.objectStore('docs');
      docs.forEach((d) => {
        if (d && d.path) store.put(d);
      });
    } catch {
      // Ignore quota errors
    }
  },
};

function naturalCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'ko', {
    numeric: true,
    sensitivity: 'base',
  });
}

function slugifyHeading(text) {
  const clean = String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~_\[\](){}!@#$%^&+=|\\:;"'<>,.?/]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return clean || 'section';
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsAttr(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

function showXpToast(message) {
  const div = document.createElement('div');
  div.className = 'xp-toast-float';
  div.textContent = message;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1900);
}

function setCacheStatusText(text) {
  const el = document.getElementById('cache-status-badge');
  if (el) el.textContent = text;
}

function updateCacheSyncUI({
  phase = 'syncing', // 'syncing' | 'preloading' | 'completed'
  loaded = 0,
  total = 0,
  etaSec = null,
  title = '',
  subtext = '',
} = {}) {
  const card = document.getElementById('cache-status-card');
  const badge = document.getElementById('cache-status-badge');
  const etaPill = document.getElementById('cache-status-eta');
  const bar = document.getElementById('cache-progress-bar');
  const subEl = document.getElementById('cache-status-subtext');

  const safeTotal = Math.max(0, Number(total || 0));
  const safeLoaded = Math.max(0, Math.min(safeTotal || loaded, Number(loaded || 0)));
  const pct = safeTotal > 0 ? Math.min(100, Math.round((safeLoaded / safeTotal) * 100)) : phase === 'completed' ? 100 : 20;

  if (phase === 'completed') {
    if (card) {
      card.style.borderColor = 'rgba(16, 185, 129, 0.48)';
      card.style.background = 'rgba(16, 185, 129, 0.08)';
    }
    if (badge) {
      badge.style.color = '#059669';
      badge.textContent = title || '✅ 모든 동기화 100% 완료!';
    }
    if (etaPill) {
      etaPill.style.background = 'rgba(16, 185, 129, 0.18)';
      etaPill.style.color = '#059669';
      etaPill.textContent = '완료 (100%)';
    }
    if (bar) {
      bar.style.width = '100%';
      bar.style.background = '#10b981';
    }
    if (subEl) {
      subEl.textContent =
        subtext || `⚡ 전체 ${safeTotal}개 문서 대기시간 없이(0.01초) 즉시 열람 가능`;
    }
    return;
  }

  if (card) {
    card.style.borderColor = 'var(--border-color)';
    card.style.background = 'var(--bg-surface)';
  }
  if (badge) {
    badge.style.color = 'var(--accent-color)';
    badge.textContent =
      title ||
      (phase === 'preloading'
        ? `⏳ 초고속 열람 세팅 중 (${safeLoaded}/${safeTotal}개)`
        : '🔄 서재 동기화 진행 중...');
  }
  if (etaPill) {
    etaPill.style.background = 'var(--accent-soft)';
    etaPill.style.color = 'var(--accent-color)';
    if (typeof etaSec === 'number' && etaSec > 0) {
      etaPill.textContent = `${pct}% · 약 ${Math.max(1, Math.ceil(etaSec))}초 남음`;
    } else {
      etaPill.textContent = `${pct}%`;
    }
  }
  if (bar) {
    bar.style.width = `${Math.max(8, pct)}%`;
    bar.style.background = 'var(--accent-color)';
  }
  if (subEl) {
    subEl.textContent =
      subtext ||
      (phase === 'preloading'
        ? '문서 본문·수식·이미지를 브라우저에 사전 저장 중입니다...'
        : '볼트 폴더와 문서 변경사항을 확인하고 있습니다...');
  }
}

/* =========================================================
   Obsidian High-Fidelity Markdown, Bold (** **) & Math/LaTeX Engine
   ========================================================= */
const OBS_LATEX_SYMBOLS = {
  rightarrow: '→',
  to: '→',
  Rightarrow: '⇒',
  implies: '⇒',
  leftarrow: '←',
  gets: '←',
  Leftarrow: '⇐',
  leftrightarrow: '↔',
  Leftrightarrow: '⇔',
  iff: '⇔',
  uparrow: '↑',
  Uparrow: '⇑',
  downarrow: '↓',
  Downarrow: '⇓',
  mapsto: '↦',
  longmapsto: '⟼',
  longrightarrow: '⟶',
  Longrightarrow: '⟹',
  longleftarrow: '⟵',
  Longleftarrow: '⟸',
  longleftrightarrow: '⟷',
  Longleftrightarrow: '⟺',
  nearrow: '↗',
  searrow: '↘',
  swarrow: '↙',
  nwarrow: '↖',
  times: '×',
  div: '÷',
  pm: '±',
  mp: '∓',
  cdot: '·',
  bullet: '•',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  degree: '°',
  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  sim: '∼',
  simeq: '≃',
  cong: '≅',
  equiv: '≡',
  propto: '∝',
  infty: '∞',
  therefore: '∴',
  because: '∵',
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  subseteq: '⊆',
  supset: '⊃',
  supseteq: '⊇',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  varnothing: '∅',
  nabla: '∇',
  partial: '∂',
  perp: '⊥',
  parallel: '∥',
  angle: '∠',
  triangle: '△',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
};

function replaceBareLatexMacros(str) {
  if (!str || !str.includes('\\')) return str;
  let out = str;
  // Handle common bare LaTeX wrappers like \textbf{...}, \text{...}, \frac{a}{b}, \sqrt{x}
  out = out.replace(/\\textbf\{([^{}\n]+)\}/g, '<strong class="obs-bold">$1</strong>');
  out = out.replace(/\\(?:text|mathrm|mathbf)\{([^{}\n]+)\}/g, '$1');
  out = out.replace(
    /\\frac\{([^{}\n]+)\}\{([^{}\n]+)\}/g,
    '<span class="obs-math-inline"><sup>$1</sup>&frasl;<sub>$2</sub></span>'
  );
  out = out.replace(/\\sqrt\{([^{}\n]+)\}/g, '<span class="obs-math-inline">√($1)</span>');
  // Replace standalone LaTeX symbol macros (\rightarrow -> →, etc.)
  out = out.replace(/\\([a-zA-Z]+)(?![a-zA-Z])/g, (match, cmd) => {
    return Object.prototype.hasOwnProperty.call(OBS_LATEX_SYMBOLS, cmd)
      ? OBS_LATEX_SYMBOLS[cmd]
      : match;
  });
  return out;
}

function renderLatexFallback(tex, displayMode = false) {
  let html = escapeHtml(tex.trim());
  html = replaceBareLatexMacros(html);
  html = html.replace(/\^\{([^{}]+)\}/g, '<sup>$1</sup>');
  html = html.replace(/\^([0-9a-zA-Z+-])/g, '<sup>$1</sup>');
  html = html.replace(/_\{([^{}]+)\}/g, '<sub>$1</sub>');
  html = html.replace(/_([0-9a-zA-Z+-])/g, '<sub>$1</sub>');
  return displayMode
    ? `<div class="obs-math-block">${html}</div>`
    : `<span class="obs-math-inline">${html}</span>`;
}

function renderLatexExpression(tex, displayMode = false) {
  const cleanTex = String(tex || '').trim();
  if (!cleanTex) return '';
  if (window.katex && typeof window.katex.renderToString === 'function') {
    try {
      const rendered = window.katex.renderToString(cleanTex, {
        displayMode,
        throwOnError: false,
        strict: false,
        trust: true,
      });
      return displayMode
        ? `<div class="obs-math-block">${rendered}</div>`
        : `<span class="obs-math-inline">${rendered}</span>`;
    } catch {
      return renderLatexFallback(cleanTex, displayMode);
    }
  }
  return renderLatexFallback(cleanTex, displayMode);
}

function renderObsidianMarkdownToHtml(rawMarkdown) {
  if (!rawMarkdown) return '';
  let text = String(rawMarkdown);

  // 1a. Protect fenced code blocks (```...``` or ~~~...~~~) with underscore-free tokens
  const fencedCodePlaceholders = [];
  const saveFencedCode = (match) => {
    const idx = fencedCodePlaceholders.length;
    fencedCodePlaceholders.push(match);
    return `@@OBSIFENCE${idx}@@`;
  };
  text = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, saveFencedCode);

  // 1b. Protect inline code (`...` or ``...``) and pre-render to <code>...</code>
  //     with underscore-free tokens so neither Step 5 nor marked.parse() can mangle them
  const inlineCodePlaceholders = [];
  const saveInlineCode = (_, codeContent) => {
    const idx = inlineCodePlaceholders.length;
    inlineCodePlaceholders.push(`<code>${escapeHtml(codeContent)}</code>`);
    return `@@OBSICODE${idx}@@`;
  };
  text = text.replace(/``([^\n]+?)``/g, saveInlineCode);
  text = text.replace(/`([^`\n]+)`/g, saveInlineCode);

  // 2. Strip Obsidian comments %%...%%
  text = text.replace(/%%[\s\S]*?%%/g, '');

  // 3. Extract & Render Math Expressions ($$...$$, \[...\], $...$, \(...\)) BEFORE marked.parse()
  //    using underscore-free tokens (@@OBSIMATH0@@) so underscore/emphasis rules never touch them
  const mathPlaceholders = [];
  const saveMath = (tex, isBlock) => {
    const idx = mathPlaceholders.length;
    mathPlaceholders.push(renderLatexExpression(tex, isBlock));
    return `@@OBSIMATH${idx}@@`;
  };

  // Block math: $$ ... $$ or \[ ... \]
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (match, tex) => {
    if (tex.includes('@@OBSIFENCE')) return match;
    return saveMath(tex, true);
  });
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (match, tex) => {
    if (tex.includes('@@OBSIFENCE')) return match;
    return saveMath(tex, true);
  });

  // Inline math: \( ... \) or $ ... $ (avoiding currency like $100 and $200 or spanning across code)
  text = text.replace(/\\\(([^\n]+?)\\\)/g, (match, tex) => {
    if (tex.includes('@@OBSICODE') || tex.includes('@@OBSIFENCE')) return match;
    return saveMath(tex, false);
  });
  text = text.replace(/(?<!\\|\$)\$(?!\s)((?:\\.|[^$\n])+?)(?<!\s|\$)\$(?!\$)/g, (match, tex) => {
    if (tex.includes('@@OBSICODE') || tex.includes('@@OBSIFENCE')) return match;
    // Skip if it looks like two plain numbers with a currency sign
    if (/^\d+(?:[.,]\d+)?(?:\s+|[가-힣]|원|달러|불)/.test(tex) && !/[=+\-^_\\]/.test(tex)) {
      return match;
    }
    return saveMath(tex, false);
  });

  // 4. Replace bare LaTeX symbols written outside $...$ (e.g., 조 (\rightarrow) -> 조 (→))
  text = replaceBareLatexMacros(text);

  // 5. Convert Obsidian **bold**, __bold__, ~~strikethrough~~, and ==highlight==
  //    before marked.parse() so Korean postpositions after parentheses/punctuation
  //    (e.g., **회전근개(Rotator Cuff)**는, **조 (→)**가) ALWAYS render as bold!
  text = text.replace(/\*\*(?!\s*\*\*)([^\n]+?)\*\*/g, (match, inner) => {
    const trimmed = inner.trim();
    if (!trimmed) return match;
    return `<strong class="obs-bold">${trimmed}</strong>`;
  });
  text = text.replace(
    /(^|[\s([{"'])__(?!\s*__)([^\n_]+?)__(?=$|[\s.,!?:;)\]}"'가-힣])/gm,
    (match, prefix, inner) => {
      const trimmed = inner.trim();
      if (!trimmed) return match;
      return `${prefix}<strong class="obs-bold">${trimmed}</strong>`;
    }
  );
  // IMPORTANT: In Obsidian, ONLY exact double-tilde ~~text~~ is strikethrough!
  // Single tilde ~ (e.g., Korean range 10~15회, 1~2주, ~30초) must NEVER become strikethrough!
  text = text.replace(/(?<!~)~~(?=\S)([^\n~]*?\S)~~(?!~)/g, (match, inner) => {
    const trimmed = inner.trim();
    if (!trimmed) return match;
    return `<del class="obs-del">${trimmed}</del>`;
  });
  // Escape all remaining ~ characters outside code blocks so marked.js (GFM) NEVER turns
  // Korean range tildes (10~15회 반복, 3~5세트) into <del> strikethroughs!
  text = text.replace(/~/g, '&#126;');

  // Protect underscores attached to word characters (e.g. (A_1)와 (B_2), 01_파일명_테스트)
  // so marked.js never accidentally turns text between two underscores into italics!
  text = text.replace(/([A-Za-z0-9가-힣)\]])_([A-Za-z0-9가-힣(])/g, '$1&#95;$2');

  text = text.replace(/==(?!=)([^\n=]+?)==/g, (match, inner) => {
    const trimmed = inner.trim();
    if (!trimmed) return match;
    return `<mark class="obs-hl">${trimmed}</mark>`;
  });

  // 6. Restore fenced code blocks so marked.parse() builds standard <pre><code> & mermaid elements
  if (fencedCodePlaceholders.length > 0) {
    text = text.replace(/@@OBSI(?:_|&#95;)?FENCE(?:_|&#95;)?(\d+)@@/g, (_, idxStr) => {
      return fencedCodePlaceholders[Number(idxStr)] ?? '';
    });
  }

  // 7. Parse Markdown to HTML
  marked.setOptions({
    gfm: true,
    breaks: true,
  });
  let html = marked.parse(text);

  // 8. Restore pre-rendered KaTeX Math HTML & Inline Code HTML (multi-pass for nested tokens)
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    if (mathPlaceholders.length > 0 && html.includes('OBSI')) {
      const nextHtml = html.replace(/@@OBSI(?:_|&#95;)?MATH(?:_|&#95;)?(\d+)@@/g, (_, idxStr) => {
        changed = true;
        return mathPlaceholders[Number(idxStr)] ?? '';
      });
      html = nextHtml;
    }
    if (inlineCodePlaceholders.length > 0 && html.includes('OBSI')) {
      const nextHtml = html.replace(/@@OBSI(?:_|&#95;)?CODE(?:_|&#95;)?(\d+)@@/g, (_, idxStr) => {
        changed = true;
        return inlineCodePlaceholders[Number(idxStr)] ?? '';
      });
      html = nextHtml;
    }
    if (fencedCodePlaceholders.length > 0 && html.includes('OBSI')) {
      const nextHtml = html.replace(/@@OBSI(?:_|&#95;)?FENCE(?:_|&#95;)?(\d+)@@/g, (_, idxStr) => {
        changed = true;
        return fencedCodePlaceholders[Number(idxStr)] ?? '';
      });
      html = nextHtml;
    }
    if (!changed) break;
  }

  // 9. Swap any /api/asset?path=... URLs that are already in RAM (state.assetBlobUrlMap)
  //    directly to their instant 0ms blob: URL BEFORE the DOM even parses <img>!
  if (state.assetBlobUrlMap.size > 0 && html.includes('/api/asset?path=')) {
    html = html.replace(
      /src="(\/api\/asset\?path=[^"]+)"/g,
      (fullMatch, assetUrl) => {
        const blobUrl = state.assetBlobUrlMap.get(assetUrl);
        if (blobUrl) {
          return `src="${blobUrl}" data-asset-src="${assetUrl}"`;
        }
        return fullMatch;
      }
    );
  }

  return html;
}

/* =========================================================
   Two-Tier Client Image Cache (L1 RAM Blob URL + L2 CacheStorage)
   ========================================================= */
const ObsiBookAssetCache = {
  cacheName: 'ObsiBookAssets_v2',
  cachePromise: null,
  openCache() {
    if (this.cachePromise) return this.cachePromise;
    if (typeof window === 'undefined' || !('caches' in window)) {
      this.cachePromise = Promise.resolve(null);
      return this.cachePromise;
    }
    this.cachePromise = window.caches.open(this.cacheName).catch(() => null);
    return this.cachePromise;
  },
  async ensureBlobUrl(assetUrl) {
    if (!assetUrl || !assetUrl.startsWith('/api/asset')) return assetUrl;
    const existingBlobUrl = state.assetBlobUrlMap.get(assetUrl);
    if (existingBlobUrl) return existingBlobUrl;

    const inFlight = state.assetFetchInFlight.get(assetUrl);
    if (inFlight) return inFlight;

    const p = (async () => {
      try {
        const cache = await this.openCache();
        if (cache) {
          const cachedRes = await cache.match(assetUrl);
          if (cachedRes && cachedRes.ok) {
            const blob = await cachedRes.blob();
            if (blob && blob.size > 0) {
              const blobUrl = URL.createObjectURL(blob);
              state.assetBlobUrlMap.set(assetUrl, blobUrl);
              return blobUrl;
            }
          }
        }

        const headers = {};
        const token = localStorage.getItem('obsibook_token') || '';
        if (token) headers['X-ObsiBook-Token'] = token;

        const res = await fetch(assetUrl, { headers });
        if (!res.ok) return assetUrl;

        if (cache) {
          try {
            await cache.put(assetUrl, res.clone());
          } catch {
            // Ignore storage quota warnings
          }
        }
        const blob = await res.blob();
        if (blob && blob.size > 0) {
          const blobUrl = URL.createObjectURL(blob);
          state.assetBlobUrlMap.set(assetUrl, blobUrl);
          return blobUrl;
        }
      } catch {
        // Fallback to direct URL
      }
      return assetUrl;
    })().finally(() => {
      state.assetFetchInFlight.delete(assetUrl);
    });

    state.assetFetchInFlight.set(assetUrl, p);
    return p;
  },
};

function extractAssetUrlsFromMarkdown(markdownContent) {
  if (!markdownContent || !markdownContent.includes('/api/asset?path=')) return [];
  const urls = [];
  const matches = markdownContent.matchAll(/\/api\/asset\?path=[^)"'\s>]+/g);
  for (const m of matches) {
    const url = m[0];
    // Skip PDFs in iframe embeds so we only blob-cache images
    if (url.toLowerCase().endsWith('.pdf')) continue;
    urls.push(url);
  }
  return urls;
}

function prewarmDocImages(markdownContent) {
  const urls = extractAssetUrlsFromMarkdown(markdownContent);
  urls.slice(0, 12).forEach((url) => {
    ObsiBookAssetCache.ensureBlobUrl(url);
  });
}

function enhanceArticleImages(container) {
  if (!container) return;
  const imgs = container.querySelectorAll('img');
  imgs.forEach((img) => {
    // Use eager loading + async decoding so scrolling down a note NEVER pauses to lazy-load photos!
    img.loading = 'eager';
    img.decoding = 'async';
    if ('fetchPriority' in img) img.fetchPriority = 'high';

    const rawSrc = img.getAttribute('src') || '';
    if (rawSrc.startsWith('/api/asset?path=')) {
      const memBlobUrl = state.assetBlobUrlMap.get(rawSrc);
      if (memBlobUrl) {
        img.dataset.assetSrc = rawSrc;
        img.src = memBlobUrl;
      } else {
        ObsiBookAssetCache.ensureBlobUrl(rawSrc).then((blobUrl) => {
          if (blobUrl && blobUrl !== rawSrc && !img.complete) {
            img.dataset.assetSrc = rawSrc;
            img.src = blobUrl;
          }
        });
      }
    }

    // Support Obsidian image dimension syntax: ![[image.png|500]] or ![alt|500x300](...)
    const rawAlt = (img.getAttribute('alt') || '').trim();
    const pipeMatch = rawAlt.match(/^(.*?)\|(\d{2,4})(?:x(\d{2,4}))?$/);
    const bareSizeMatch = !pipeMatch ? rawAlt.match(/^(\d{2,4})(?:x(\d{2,4}))?$/) : null;
    if (pipeMatch) {
      const cleanAlt = pipeMatch[1].trim();
      const widthPx = Number(pipeMatch[2]);
      if (widthPx > 0) {
        img.dataset.sized = String(widthPx);
      }
      img.setAttribute('alt', cleanAlt);
    } else if (bareSizeMatch) {
      const widthPx = Number(bareSizeMatch[1]);
      if (widthPx > 0) {
        img.dataset.sized = String(widthPx);
      }
      img.setAttribute('alt', '');
    }

    // 본문 배율(--reader-zoom)에 맞춰 사진도 같이 확대/축소: (지정 크기 또는 원래 크기) × 배율, 본문 폭은 넘지 않음
    const fitToZoom = () => {
      const base = Number(img.dataset.sized) || img.naturalWidth;
      if (base > 0) img.style.width = `min(100%, calc(${base}px * var(--reader-zoom, 1)))`;
    };
    if (img.dataset.sized || (img.complete && img.naturalWidth)) fitToZoom();
    img.addEventListener('load', fitToZoom);
  });
}

async function apiFetch(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  const token = localStorage.getItem('obsibook_token') || '';
  if (token) {
    headers['X-ObsiBook-Token'] = token;
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    showAuthModal();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

/* =========================================================
   Initialization & Auth
   ========================================================= */
document.addEventListener('DOMContentLoaded', async () => {
  if (window.mermaid) {
    mermaid.initialize({ startOnLoad: false, theme: 'default' });
  }

  setupAuthForm();
  setupBookmarkColorPicker();
  setupScrollListener();
  setupKeyboardShortcuts();
  setupMobileAndTouchUX();
  setupTextSelectionToolbar();
  setupBrowserHistoryListener();
  setupOutsidePopoverClickCloser();

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar-left').classList.add('collapsed');
  }

  try {
    const auth = await fetch('/api/auth/status').then((r) => r.json());
    if (auth.vault_title) {
      document.getElementById('header-vault-title').textContent = auth.vault_title;
      document.getElementById('dash-title').textContent = auth.vault_title;
      document.getElementById('auth-vault-title').textContent = `${auth.vault_title} 잠금`;
      document.title = `${auth.vault_title} — ObsiBook`;
    }
    if (auth.requires_auth && !auth.authenticated) {
      showAuthModal();
      return;
    }
    await loadLibrary();
  } catch (err) {
    console.error('Initialization error:', err);
  }
});

function setupOutsidePopoverClickCloser() {
  document.addEventListener('mousedown', (e) => {
    const settingsPop = document.getElementById('settings-popover');
    if (settingsPop && !settingsPop.classList.contains('hidden')) {
      const parent = settingsPop.parentElement;
      if (parent && !parent.contains(e.target)) {
        settingsPop.classList.add('hidden');
      }
    }
    const pomoPop = document.getElementById('pomodoro-popover');
    if (pomoPop && !pomoPop.classList.contains('hidden')) {
      const parent = pomoPop.parentElement;
      if (parent && !parent.contains(e.target)) {
        pomoPop.classList.add('hidden');
      }
    }
  });
}

function showAuthModal() {
  const modal = document.getElementById('auth-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('auth-password-input').focus();
}

function hideAuthModal() {
  const modal = document.getElementById('auth-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function setupAuthForm() {
  const form = document.getElementById('auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pwd = document.getElementById('auth-password-input').value;
    const errEl = document.getElementById('auth-error-msg');
    errEl.classList.add('hidden');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd }),
      });
      const data = await res.json();
      if (!res.ok) {
        errEl.textContent = data.detail || '비밀번호가 올바르지 않습니다.';
        errEl.classList.remove('hidden');
        return;
      }
      if (data.token) {
        localStorage.setItem('obsibook_token', data.token);
      }
      hideAuthModal();
      await loadLibrary();
    } catch (err) {
      errEl.textContent = '로그인 중 오류가 발생했습니다.';
      errEl.classList.remove('hidden');
    }
  });
}

/* =========================================================
   Navigation History (Back / Forward) & Open Study Tabs
   ========================================================= */
function pushNavHistory(entry) {
  if (state.suppressHistoryPush) return;

  const current = state.navHistory[state.navIndex];
  if (
    current &&
    current.type === entry.type &&
    (current.path || '') === (entry.path || '')
  ) {
    return;
  }

  state.navHistory = state.navHistory.slice(0, state.navIndex + 1);
  state.navHistory.push(entry);
  state.navIndex = state.navHistory.length - 1;

  let hash = '';
  if (entry.type === 'doc' && entry.path) {
    hash = `#doc=${encodeURIComponent(entry.path)}`;
  } else if (entry.type === 'folder' && entry.path) {
    hash = `#folder=${encodeURIComponent(entry.path)}`;
  }
  window.history.pushState(entry, '', hash || window.location.pathname);
  updateNavButtonsUI();
}

function updateNavButtonsUI() {
  const backBtn = document.getElementById('btn-nav-back');
  const fwdBtn = document.getElementById('btn-nav-forward');
  if (backBtn) backBtn.disabled = state.navIndex <= 0;
  if (fwdBtn) fwdBtn.disabled = state.navIndex >= state.navHistory.length - 1;
}

async function navigateBack() {
  if (state.navIndex <= 0) return;
  state.navIndex -= 1;
  const target = state.navHistory[state.navIndex];
  updateNavButtonsUI();
  await restoreHistoryEntry(target);
}

async function navigateForward() {
  if (state.navIndex >= state.navHistory.length - 1) return;
  state.navIndex += 1;
  const target = state.navHistory[state.navIndex];
  updateNavButtonsUI();
  await restoreHistoryEntry(target);
}

async function restoreHistoryEntry(entry) {
  if (!entry) return;
  state.suppressHistoryPush = true;
  try {
    if (entry.type === 'dashboard') {
      showDashboard({ skipHistory: true });
    } else if (entry.type === 'folder') {
      openFolderExplorer(entry.path, { skipHistory: true });
    } else if (entry.type === 'doc') {
      await openDocument(entry.path, { skipHistory: true });
    }
  } finally {
    state.suppressHistoryPush = false;
  }
}

function setupBrowserHistoryListener() {
  window.addEventListener('popstate', async (e) => {
    if (e.state && e.state.type) {
      const idx = state.navHistory.findIndex(
        (h) => h.type === e.state.type && (h.path || '') === (e.state.path || '')
      );
      if (idx !== -1) state.navIndex = idx;
      updateNavButtonsUI();
      await restoreHistoryEntry(e.state);
      return;
    }
    const hash = window.location.hash || '';
    state.suppressHistoryPush = true;
    try {
      if (hash.startsWith('#doc=')) {
        await openDocument(decodeURIComponent(hash.slice(5)), { skipHistory: true });
      } else if (hash.startsWith('#folder=')) {
        openFolderExplorer(decodeURIComponent(hash.slice(8)), { skipHistory: true });
      } else {
        showDashboard({ skipHistory: true });
      }
    } finally {
      state.suppressHistoryPush = false;
    }
  });
}

function addOrActivateStudyTab(doc) {
  const exists = state.openTabs.find((t) => t.path === doc.path);
  if (!exists) {
    state.openTabs.push({
      path: doc.path,
      title: doc.title,
      folder: doc.folder || doc.top_folder || 'Root',
    });
    if (state.openTabs.length > 10) {
      state.openTabs.shift();
    }
  }
  renderStudyTabsBar();
}

function closeStudyTab(docPath, event) {
  if (event) event.stopPropagation();
  const idx = state.openTabs.findIndex((t) => t.path === docPath);
  if (idx === -1) return;
  state.openTabs.splice(idx, 1);

  if (state.currentView === 'doc' && state.currentDoc && state.currentDoc.path === docPath) {
    if (state.openTabs.length > 0) {
      const nextTab = state.openTabs[Math.max(0, idx - 1)];
      openDocument(nextTab.path);
    } else if (state.currentDoc.folder) {
      openFolderExplorer(state.currentDoc.folder);
    } else {
      showDashboard();
    }
  } else {
    renderStudyTabsBar();
  }
}

function renderStudyTabsBar() {
  const bar = document.getElementById('study-tabs-bar');
  if (!bar) return;

  const isDash = state.currentView === 'dashboard';
  const isFolder = state.currentView === 'folder';

  let html = `
    <div onclick="showDashboard()"
         class="study-tab-item ${isDash ? 'active' : ''}"
         title="전체 서재 대시보드">
      <span>🏠 서재 홈</span>
    </div>
  `;

  if (state.currentFolderPath) {
    const folderName = state.currentFolderPath.split('/').pop() || state.currentFolderPath;
    html += `
      <div onclick="openFolderExplorer('${escapeJsAttr(state.currentFolderPath)}')"
           class="study-tab-item ${isFolder ? 'active' : ''}"
           title="폴더 탐색기: ${escapeHtml(state.currentFolderPath)}">
        <span>📂 ${escapeHtml(folderName)}</span>
      </div>
    `;
  }

  state.openTabs.forEach((tab) => {
    const isActive = state.currentView === 'doc' && state.currentDoc && state.currentDoc.path === tab.path;
    html += `
      <div onclick="openDocument('${escapeJsAttr(tab.path)}')"
           class="study-tab-item ${isActive ? 'active' : ''}"
           title="${escapeHtml(tab.folder)} / ${escapeHtml(tab.title)}">
        <span class="truncate">📄 ${escapeHtml(tab.title)}</span>
        <span onclick="closeStudyTab('${escapeJsAttr(tab.path)}', event)" class="study-tab-close" title="탭 닫기">✕</span>
      </div>
    `;
  });

  bar.innerHTML = html;
}

/* =========================================================
   Library Loading, Background Pre-Caching & Local State Sync
   ========================================================= */
function applyLibraryDataToUI(data, isInitialSnapshot = false) {
  state.library = data;

  if (data.settings) {
    state.settings = { ...state.settings, ...data.settings };
    applySettingsToDOM();
  }

  if (state.expandedFolders.size === 0 && data.folders) {
    data.folders.forEach((f) => state.expandedFolders.add(f.path || f.name));
  }

  updateHeaderAndStats();
  renderSidebar();
  if (state.currentView === 'dashboard') {
    renderDashboard();
  } else if (state.currentView === 'folder') {
    renderFolderExplorerContent();
  }
  renderStudyTabsBar();

  if (!isInitialSnapshot) {
    ObsiBookIDB.saveLibrarySnapshot(data);
    startBackgroundPreloader();
  }
}

async function loadLibrary() {
  // 1. Instant 0ms boot from Browser IndexedDB snapshot if available!
  const cachedSnap = await ObsiBookIDB.getLibrarySnapshot();
  const cachedDocs = await ObsiBookIDB.getAllCachedDocs();
  if (cachedDocs && cachedDocs.length > 0) {
    cachedDocs.forEach((d) => {
      if (d && d.path) state.docCache.set(d.path, d);
    });
  }

  let handledInitialRoute = false;
  if (cachedSnap && cachedSnap.documents) {
    applyLibraryDataToUI(cachedSnap, true);
    updateCacheSyncUI({
      phase: 'syncing',
      loaded: state.docCache.size,
      total: (cachedSnap.documents || []).length,
      etaSec: 1,
      title: `🔄 최신 변경사항 동기화 중...`,
      subtext: `⚡ 캐시된 문서 ${state.docCache.size}개 즉시 로드됨 · 서버 확인 중`,
    });

    const hash = window.location.hash;
    if (hash.startsWith('#doc=')) {
      handledInitialRoute = true;
      const docPath = decodeURIComponent(hash.slice(5));
      openDocument(docPath, { skipHistory: true });
    } else if (hash.startsWith('#folder=')) {
      handledInitialRoute = true;
      const folderPath = decodeURIComponent(hash.slice(8));
      openFolderExplorer(folderPath, { skipHistory: true });
    }
  } else {
    updateCacheSyncUI({
      phase: 'syncing',
      loaded: 0,
      total: 100,
      etaSec: 2,
      title: `⏳ 서재 인덱싱 데이터 불러오는 중...`,
      subtext: `첫 접속 초고속 세팅을 준비하고 있습니다...`,
    });
  }

  // 2. Fetch fresh library state from server (served from server RAM index in ~2ms)
  const data = await apiFetch('/api/library');

  // Evict any browser-cached doc whose mtime changed on server
  const mtimeMap = new Map((data.documents || []).map((d) => [d.path, d.mtime]));
  for (const [cachedPath, cachedDoc] of state.docCache.entries()) {
    const serverMtime = mtimeMap.get(cachedPath);
    if (!serverMtime || (cachedDoc.mtime && cachedDoc.mtime !== serverMtime)) {
      state.docCache.delete(cachedPath);
    }
  }

  applyLibraryDataToUI(data, false);

  if (!handledInitialRoute) {
    const hash = window.location.hash;
    if (hash.startsWith('#doc=')) {
      const docPath = decodeURIComponent(hash.slice(5));
      await openDocument(docPath, { skipHistory: true });
    } else if (hash.startsWith('#folder=')) {
      const folderPath = decodeURIComponent(hash.slice(8));
      openFolderExplorer(folderPath, { skipHistory: true });
    }
  }
}

function collectAllCachedAssetUrls() {
  const assetSet = new Set();
  for (const docObj of state.docCache.values()) {
    if (docObj && docObj.content) {
      const urls = extractAssetUrlsFromMarkdown(docObj.content);
      urls.forEach((u) => assetSet.add(u));
    }
  }
  return Array.from(assetSet);
}

async function startBackgroundPreloader() {
  if (!state.library || state.preloaderRunning) return;
  const allDocs = state.library.documents || [];
  const totalDocs = allDocs.length;
  if (totalDocs === 0) {
    updateCacheSyncUI({
      phase: 'completed',
      loaded: 0,
      total: 0,
      title: '✅ 서재 동기화 100% 완료!',
      subtext: '볼트에 등록된 문서를 바로 열람할 수 있습니다.',
    });
    return;
  }

  // Check how many docs are already cached in state.docCache with up-to-date mtime
  const missingDocs = allDocs.filter((d) => {
    const c = state.docCache.get(d.path);
    return !c || c.mtime !== d.mtime;
  });

  state.preloaderRunning = true;
  const startTime = performance.now();
  const initialCachedCount = Math.max(0, totalDocs - missingDocs.length);

  try {
    // =========================================================================
    // STAGE 1: Preload & Cache All Markdown Documents into RAM + IndexedDB
    // =========================================================================
    if (missingDocs.length > 0) {
      if (missingDocs.length <= 10) {
        let doneCount = initialCachedCount;
        updateCacheSyncUI({
          phase: 'preloading',
          loaded: doneCount,
          total: totalDocs,
          etaSec: 1,
          title: `⏳ 변경된 문서 동기화 중 (${doneCount}/${totalDocs}개)`,
          subtext: `새로 수정된 ${missingDocs.length}개 문서를 업데이트하고 있습니다...`,
        });
        const fetchedDocs = await Promise.all(
          missingDocs.map((d) =>
            apiFetch(`/api/doc?path=${encodeURIComponent(d.path)}`).catch(() => null)
          )
        );
        const validDocs = fetchedDocs.filter((d) => d && d.path);
        validDocs.forEach((docObj) => {
          state.docCache.set(docObj.path, docObj);
        });
        await ObsiBookIDB.saveDocsBatch(validDocs);
      } else {
        let offset = 0;
        const batchSize = 40;
        let avgMsPerDoc = 12;

        while (offset < totalDocs) {
          const currentLoaded = Math.min(totalDocs, Math.max(offset, state.docCache.size));
          const remainingDocs = Math.max(0, totalDocs - currentLoaded);
          const etaSec = Math.max(1, Math.ceil((remainingDocs * avgMsPerDoc) / 1000));

          updateCacheSyncUI({
            phase: 'preloading',
            loaded: currentLoaded,
            total: totalDocs,
            etaSec,
            title: `⏳ 1/2 문서 초고속 세팅 중 (${currentLoaded}/${totalDocs}개)`,
            subtext: `문서 본문과 수식을 브라우저에 사전 저장 중입니다...`,
          });

          const tBatch0 = performance.now();
          const res = await apiFetch(`/api/docs/preload?offset=${offset}&limit=${batchSize}`);
          const batch = res.docs || [];
          if (batch.length === 0) break;

          batch.forEach((docObj) => {
            state.docCache.set(docObj.path, docObj);
          });
          await ObsiBookIDB.saveDocsBatch(batch);

          const batchElapsedMs = Math.max(5, performance.now() - tBatch0);
          avgMsPerDoc = batchElapsedMs / Math.max(1, batch.length);

          offset += batchSize;
          if (!res.has_more) break;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    }

    // =========================================================================
    // STAGE 2: Preload & Cache All Document Images into RAM Blob URLs + CacheStorage
    // =========================================================================
    const allAssetUrls = collectAllCachedAssetUrls();
    const totalAssets = allAssetUrls.length;
    const missingAssets = allAssetUrls.filter((u) => !state.assetBlobUrlMap.has(u));

    if (missingAssets.length > 0) {
      const imgBatchSize = 6;
      let loadedAssets = totalAssets - missingAssets.length;
      let avgMsPerImg = 45;

      for (let i = 0; i < missingAssets.length; i += imgBatchSize) {
        const slice = missingAssets.slice(i, i + imgBatchSize);
        const remainingImgs = Math.max(0, totalAssets - loadedAssets);
        const etaSec = Math.max(1, Math.ceil(((remainingImgs / imgBatchSize) * avgMsPerImg) / 1000));

        updateCacheSyncUI({
          phase: 'preloading',
          loaded: totalDocs + loadedAssets,
          total: totalDocs + totalAssets,
          etaSec,
          title: `⏳ 2/2 사진 초고속 캐싱 중 (${loadedAssets}/${totalAssets}장)`,
          subtext: `문서 내 사진을 WebP 초경량 메모리로 사전 로드 중입니다...`,
        });

        const tImg0 = performance.now();
        await Promise.all(slice.map((url) => ObsiBookAssetCache.ensureBlobUrl(url)));
        loadedAssets = Math.min(totalAssets, loadedAssets + slice.length);
        avgMsPerImg = Math.max(10, performance.now() - tImg0);
      }
    }

    const totalSec = ((performance.now() - startTime) / 1000).toFixed(1);
    const assetSummary = totalAssets > 0 ? ` · 사진 ${totalAssets}장` : '';
    updateCacheSyncUI({
      phase: 'completed',
      loaded: totalDocs + totalAssets,
      total: totalDocs + totalAssets,
      title: '✅ 문서·사진 모든 동기화 100% 완료!',
      subtext: `⚡ 문서 ${totalDocs}개${assetSummary} 대기시간 0초(즉시) 열람 ON`,
    });
    if (missingDocs.length >= 5) {
      showXpToast(`✅ 문서 ${totalDocs}개${assetSummary} 초고속 세팅 완료! (${totalSec}초)`);
    }
  } catch (err) {
    console.warn('Background preload paused:', err);
    updateCacheSyncUI({
      phase: 'completed',
      loaded: state.docCache.size,
      total: totalDocs,
      title: `✅ 캐시 준비 완료 (${state.docCache.size}/${totalDocs}개)`,
      subtext: `⚡ 클릭 시 대기시간 없이 문서를 바로 열람할 수 있습니다`,
    });
  } finally {
    state.preloaderRunning = false;
  }
}

function prefetchDoc(docPath) {
  if (!docPath) return;
  const cached = state.docCache.get(docPath);
  if (cached) {
    prewarmDocImages(cached.content);
    return;
  }
  if (state.prefetchInFlight.has(docPath)) return;
  const p = apiFetch(`/api/doc?path=${encodeURIComponent(docPath)}`)
    .then((doc) => {
      if (doc && doc.path) {
        state.docCache.set(doc.path, doc);
        ObsiBookIDB.saveDocsBatch([doc]);
        prewarmDocImages(doc.content);
      }
      return doc;
    })
    .catch(() => null)
    .finally(() => {
      state.prefetchInFlight.delete(docPath);
    });
  state.prefetchInFlight.set(docPath, p);
}

function enrichDocWithLibraryState(rawDoc) {
  const doc = { ...rawDoc };
  if (!state.library) return doc;

  const libDoc = (state.library.documents || []).find((d) => d.path === doc.path);
  const existingProg = doc.progress || {};
  doc.progress = {
    doc_path: doc.path,
    scroll_percent: libDoc ? Number(libDoc.scroll_percent || 0) : Number(existingProg.scroll_percent || 0),
    scroll_top: Number(existingProg.scroll_top || 0),
    heading_id: existingProg.heading_id || '',
    heading_text: (libDoc && libDoc.heading_text) || existingProg.heading_text || '',
    is_completed: libDoc ? (libDoc.is_completed ? 1 : 0) : Number(existingProg.is_completed || 0),
    last_read_at: (libDoc && libDoc.last_read_at) || existingProg.last_read_at || '',
  };

  doc.bookmarks = (state.library.bookmarks || []).filter((b) => b.doc_path === doc.path);
  doc.highlights = (state.library.highlights || []).filter((h) => h.doc_path === doc.path);
  const sn = (state.library.study_notes || []).find((n) => n.doc_path === doc.path);
  if (sn) {
    doc.study_note = sn;
  } else if (!doc.study_note) {
    doc.study_note = { doc_path: doc.path, title: doc.title, folder: doc.folder, content: '', updated_at: '' };
  }
  return doc;
}

function syncLocalDocProgress(docPath, progressObj) {
  if (!state.library || !progressObj) return;
  const pct = Number(progressObj.scroll_percent || 0);
  const done = Boolean(progressObj.is_completed);
  const lastRead = progressObj.last_read_at || '';
  const headingText = progressObj.heading_text || '';

  const updateDocItem = (d) => {
    if (d && d.path === docPath) {
      d.scroll_percent = pct;
      d.is_completed = done;
      if (lastRead) d.last_read_at = lastRead;
      if (headingText) d.heading_text = headingText;
    }
  };

  (state.library.documents || []).forEach(updateDocItem);
  Object.values(state.library.directories || {}).forEach((dir) => {
    (dir.direct_docs || []).forEach(updateDocItem);
  });

  const walkTree = (nodes) => {
    (nodes || []).forEach((n) => {
      (n.direct_docs || []).forEach(updateDocItem);
      if (n.children) walkTree(n.children);
    });
  };
  walkTree(state.library.folder_tree);

  // Update recent_reads
  const libDoc = (state.library.documents || []).find((d) => d.path === docPath);
  if (libDoc) {
    const recList = (state.library.recent_reads || []).filter((r) => r.doc_path !== docPath);
    recList.unshift({
      doc_path: docPath,
      title: libDoc.title,
      subtitle: libDoc.subtitle || '',
      folder: libDoc.folder || libDoc.top_folder || 'Root',
      scroll_percent: pct,
      heading_text: headingText,
      is_completed: done ? 1 : 0,
      last_read_at: lastRead || '방금 전',
    });
    state.library.recent_reads = recList.slice(0, 12);
  }

  // Recompute global stats
  const allDocs = state.library.documents || [];
  state.library.stats.completed_docs = allDocs.filter((d) => d.is_completed).length;
  state.library.stats.in_progress_docs = allDocs.filter((d) => !d.is_completed && (d.scroll_percent || 0) > 0).length;

  const cached = state.docCache.get(docPath);
  if (cached) {
    cached.progress = { ...(cached.progress || {}), ...progressObj };
  }

  updateHeaderAndStats();
  updateSidebarDocBadgeInPlace(docPath, pct, done);
}

function updateSidebarDocBadgeInPlace(docPath, pct, isCompleted) {
  const rows = document.querySelectorAll('.tree-doc-row');
  rows.forEach((row) => {
    if (row.dataset.docPath === docPath) {
      const badgeSpan = row.querySelector('.tree-doc-badge');
      if (badgeSpan) {
        if (isCompleted) {
          badgeSpan.innerHTML = `<span class="text-emerald-600 font-bold text-[10px]">✓</span>`;
        } else if (Math.round(pct) > 0) {
          badgeSpan.innerHTML = `<span class="text-[10px] font-bold" style="color: var(--accent-color);">${Math.round(pct)}%</span>`;
        } else {
          badgeSpan.innerHTML = '';
        }
      }
    }
  });
}

async function refreshLibrary(forceRescan = false) {
  if (forceRescan) {
    updateCacheSyncUI({
      phase: 'syncing',
      loaded: 0,
      total: state.library?.stats?.total_docs || 100,
      etaSec: 1,
      title: '🔄 볼트 폴더·파일 변경사항 스캔 중...',
      subtext: '새로 추가되거나 수정된 옵시디언 문서를 확인하고 있습니다...',
    });
  }
  const data = forceRescan
    ? await apiFetch('/api/library/rescan', { method: 'POST' })
    : await apiFetch('/api/library');
  applyLibraryDataToUI(data, false);
  if (forceRescan) {
    showXpToast(`✅ 서재 동기화 완료 (${data.stats?.total_docs || 0}개 파일)`);
  }
}

function updateHeaderAndStats() {
  if (!state.library) return;
  const s = state.library.stats;
  const st = state.library.study_stats || {};

  document.getElementById('stat-total-docs').textContent = s.total_docs;
  document.getElementById('stat-reading-docs').textContent = s.in_progress_docs;
  document.getElementById('stat-completed-docs').textContent = s.completed_docs;
  document.getElementById('stat-study-highlights').textContent =
    (s.total_highlights || 0) + (s.total_bookmarks || 0);

  document.getElementById('sidebar-footer-stats').textContent =
    `총 ${s.total_docs}개 파일 · 읽는 중 ${s.in_progress_docs} · 완독 ${s.completed_docs}`;

  const totalNotes = (s.total_bookmarks || 0) + (s.total_highlights || 0);
  const bmCountEl = document.getElementById('sidebar-bm-count');
  bmCountEl.textContent = totalNotes > 0 ? `(${totalNotes})` : '';

  updateStudyGamificationUI(st);
}

function updateStudyGamificationUI(st) {
  if (!st || !st.level) return;
  if (state.library) {
    state.library.study_stats = st;
  }

  const hdrLv = document.getElementById('hdr-level-text');
  const hdrStreak = document.getElementById('hdr-streak-text');
  if (hdrLv) hdrLv.textContent = `${st.level_title.split(' ')[0]} Lv.${st.level}`;
  if (hdrStreak) hdrStreak.textContent = `🔥 ${st.streak_days}일`;

  const dashLv = document.getElementById('dash-level-badge');
  const dashStreak = document.getElementById('dash-streak-badge');
  const xpLabel = document.getElementById('dash-xp-label');
  const nextLvLabel = document.getElementById('dash-next-level-label');
  const xpBar = document.getElementById('dash-xp-bar');

  if (dashLv) dashLv.textContent = `Lv.${st.level} ${st.level_title}`;
  if (dashStreak) dashStreak.textContent = `🔥 연속 ${st.streak_days}일 공부 중 · 오늘 ${st.today_minutes}분 집중`;
  if (xpLabel) xpLabel.textContent = `학습 경험치 ${st.total_xp} XP (현재 레벨 ${st.xp_in_level} / 200 XP)`;
  if (nextLvLabel) nextLvLabel.textContent = `다음 레벨까지 ${200 - st.xp_in_level} XP`;
  if (xpBar) xpBar.style.width = `${Math.max(4, st.level_progress_pct)}%`;
}

function showDashboard(options = {}) {
  stopTTS();
  flushPendingProgress();
  state.currentView = 'dashboard';
  state.currentDoc = null;

  if (!options.skipHistory) {
    pushNavHistory({ type: 'dashboard' });
  }

  document.getElementById('document-view').classList.add('hidden');
  document.getElementById('folder-explorer-view').classList.add('hidden');
  document.getElementById('dashboard-view').classList.remove('hidden');
  document.getElementById('top-progress-bar').style.width = '0%';
  hideResumeToast();

  document.getElementById('sidebar-right').classList.add('collapsed');
  renderStudyTabsBar();
  renderDashboard();
  updateSidebarActiveStates();
  document.getElementById('reader-viewport').scrollTop = 0;
}

function renderDashboard() {
  if (!state.library) return;

  // 1. Continue Reading Hero Card
  const recent = state.library.recent_reads || [];
  const contSection = document.getElementById('continue-reading-section');
  const contCard = document.getElementById('continue-reading-card');

  if (recent.length > 0) {
    const last = recent[0];
    const pct = Math.round(last.scroll_percent || 0);
    contSection.classList.remove('hidden');
    contCard.innerHTML = `
      <div class="rounded-2xl p-5 border shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4 transition hover:shadow-md cursor-pointer"
           style="background: var(--bg-surface); border-color: var(--accent-color);"
           onmouseenter="prefetchDoc('${escapeJsAttr(last.doc_path)}')"
           onclick="openDocument('${escapeJsAttr(last.doc_path)}', { restoreScroll: true })">
        <div class="space-y-1.5 min-w-0">
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <span onclick="event.stopPropagation(); openFolderExplorer('${escapeJsAttr(last.folder || '')}')"
                  class="px-2.5 py-0.5 rounded-lg font-bold hover:underline"
                  style="background: var(--accent-soft); color: var(--accent-color);">
              📂 ${escapeHtml(last.folder || 'Root')}
            </span>
            <span style="color: var(--text-muted);">마지막 열람: ${escapeHtml(last.last_read_at)}</span>
          </div>
          <h3 class="text-lg font-bold truncate">📄 ${escapeHtml(last.title)}</h3>
          ${
            last.subtitle && state.settings.showSubtitle
              ? `<p class="text-xs truncate opacity-75">${escapeHtml(last.subtitle)}</p>`
              : ''
          }
          ${
            last.heading_text
              ? `<p class="text-xs truncate" style="color: var(--text-secondary);">📍 읽던 섹션: ${escapeHtml(last.heading_text)}</p>`
              : ''
          }
          <div class="w-full max-w-md h-2 rounded-full overflow-hidden mt-2" style="background: var(--bg-secondary);">
            <div class="h-full rounded-full" style="width: ${pct}%; background: var(--accent-color);"></div>
          </div>
        </div>
        <div class="flex items-center gap-3 flex-shrink-0">
          <div class="text-right">
            <div class="text-xl font-extrabold" style="color: var(--accent-color);">${pct}%</div>
            <div class="text-[11px]" style="color: var(--text-muted);">${last.is_completed ? '✓ 완독함' : '공부 중'}</div>
          </div>
          <button type="button" class="px-4 py-2.5 rounded-xl text-xs font-bold text-white shadow" style="background: var(--accent-color);">
            이어 공부하기 →
          </button>
        </div>
      </div>
    `;
  } else {
    contSection.classList.add('hidden');
  }

  // 2. Top-Level Vault Folders (Shows Subfolders AND Direct Files clearly!)
  const foldersGrid = document.getElementById('dash-folders-grid');
  const folders = state.library.folders || [];
  foldersGrid.innerHTML = folders
    .map((f) => {
      const folderPath = f.path || f.name;
      const subfolders = f.subfolders || [];
      const directDocs = f.direct_docs || [];
      const previewSubfolders = subfolders.slice(0, 6);
      const previewDocs = directDocs.slice(0, 4);

      return `
        <div class="rounded-2xl p-5 border flex flex-col justify-between transition hover:shadow-sm"
             style="background: var(--bg-surface); border-color: var(--border-color);">
          <div>
            <!-- Folder Card Header (Click to enter Folder Explorer) -->
            <div onclick="openFolderExplorer('${escapeJsAttr(folderPath)}')"
                 class="flex items-center justify-between mb-3 cursor-pointer group">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-2xl">📂</span>
                <div class="min-w-0">
                  <h3 class="font-bold text-base truncate group-hover:underline" style="color: var(--text-primary);">
                    ${escapeHtml(f.name)}
                  </h3>
                  <div class="text-[11px]" style="color: var(--text-muted);">
                    ${subfolders.length > 0 ? `하위 폴더 ${subfolders.length}개 · ` : ''}총 파일 ${f.total_doc_count ?? f.doc_count}개 · 완독 ${f.completed_count}
                  </div>
                </div>
              </div>
              <span class="px-3 py-1 rounded-xl text-xs font-bold flex-shrink-0"
                    style="background: var(--accent-soft); color: var(--accent-color);">
                폴더 열기 →
              </span>
            </div>

            <!-- Subfolders Chips inside this Vault -->
            ${
              previewSubfolders.length > 0
                ? `
                <div class="mb-3">
                  <div class="text-[11px] font-bold mb-1.5 opacity-75">📁 하위 폴더 (${subfolders.length}개)</div>
                  <div class="flex flex-wrap gap-1.5">
                    ${previewSubfolders
                      .map(
                        (sf) => `
                        <button type="button"
                                onclick="openFolderExplorer('${escapeJsAttr(sf.path)}')"
                                class="px-2.5 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 hover:opacity-85 transition"
                                style="background: var(--bg-primary); border-color: var(--border-color);">
                          <span>📁 ${escapeHtml(sf.name)}</span>
                          <span class="text-[10px] opacity-60">(${sf.total_doc_count})</span>
                        </button>
                      `
                      )
                      .join('')}
                    ${
                      subfolders.length > 6
                        ? `<button type="button" onclick="openFolderExplorer('${escapeJsAttr(folderPath)}')" class="px-2.5 py-1.5 rounded-xl text-xs font-bold" style="color: var(--accent-color);">+${subfolders.length - 6}개 더보기</button>`
                        : ''
                    }
                  </div>
                </div>
              `
                : ''
            }

            <!-- Direct Files inside this Folder -->
            ${
              previewDocs.length > 0
                ? `
                <div class="space-y-1.5 mb-3">
                  <div class="text-[11px] font-bold opacity-75">📄 이 폴더 바로 아래의 파일 (${directDocs.length}개)</div>
                  ${previewDocs
                    .map((d) => {
                      const pct = Math.round(d.scroll_percent || 0);
                      const statusBadge = d.is_completed
                        ? `<span class="text-emerald-600 font-bold text-[11px]">✓ 완독</span>`
                        : pct > 0
                        ? `<span class="font-bold text-[11px]" style="color: var(--accent-color);">${pct}%</span>`
                        : `<span class="text-[11px] opacity-50">${d.reading_time_min}분</span>`;
                      return `
                        <div onmouseenter="prefetchDoc('${escapeJsAttr(d.path)}')"
                             onclick="openDocument('${escapeJsAttr(d.path)}')"
                             class="px-3 py-2 rounded-xl border flex items-center justify-between gap-2 cursor-pointer hover:opacity-85 transition text-xs"
                             style="background: var(--bg-primary); border-color: var(--border-color);">
                          <span class="truncate font-semibold">📄 ${escapeHtml(d.title)}</span>
                          <span class="flex-shrink-0">${statusBadge}</span>
                        </div>
                      `;
                    })
                    .join('')}
                </div>
              `
                : subfolders.length === 0
                ? `<p class="text-xs py-3 opacity-60">이 폴더에 문서가 없습니다.</p>`
                : ''
            }
          </div>

          <button type="button"
                  onclick="openFolderExplorer('${escapeJsAttr(folderPath)}')"
                  class="w-full py-2 rounded-xl border text-xs font-bold transition hover:opacity-90 mt-1"
                  style="background: var(--bg-secondary); border-color: var(--border-color); color: var(--text-primary);">
            📂 ${escapeHtml(f.name)} 전체 폴더·파일 구조 탐색하기 (${f.total_doc_count ?? f.doc_count}개)
          </button>
        </div>
      `;
    })
    .join('');

  // 3. Recent Highlights & Bookmarks Section
  const hls = (state.library.highlights || []).slice(0, 4);
  const bms = (state.library.bookmarks || []).slice(0, 4);
  const combined = [
    ...hls.map((h) => ({ ...h, _itemType: 'hl' })),
    ...bms.map((b) => ({ ...b, _itemType: 'bm' })),
  ].slice(0, 6);

  const bmSection = document.getElementById('dash-bookmarks-section');
  const bmList = document.getElementById('dash-bookmarks-list');
  if (combined.length > 0) {
    bmSection.classList.remove('hidden');
    bmList.innerHTML = combined
      .map((item) => {
        if (item._itemType === 'hl') {
          return `
            <div class="rounded-xl p-4 border flex flex-col justify-between gap-2 cursor-pointer hover:shadow-sm transition"
                 style="background: var(--bg-surface); border-color: var(--border-color);"
                 onmouseenter="prefetchDoc('${escapeJsAttr(item.doc_path)}')"
                 onclick="openDocument('${escapeJsAttr(item.doc_path)}', { targetPercent: ${item.scroll_percent || 0} })">
              <div>
                <div class="flex items-center justify-between text-[11px] mb-1">
                  <span class="font-bold" style="color: var(--accent-color);">🖍️ 형광펜 · ${escapeHtml(item.title)}</span>
                  <span style="color: var(--text-muted);">${item.mastered ? '✅ 암기완료' : '🃏 복습대상'}</span>
                </div>
                <div class="text-xs font-semibold line-clamp-2 px-2.5 py-1.5 rounded-lg" style="background: var(--hl-bg);">
                  "${escapeHtml(item.selected_text)}"
                </div>
                ${
                  item.note
                    ? `<div class="mt-1.5 text-xs opacity-85">💬 ${escapeHtml(item.note)}</div>`
                    : ''
                }
              </div>
            </div>
          `;
        }
        return `
          <div class="rounded-xl p-4 border flex flex-col justify-between gap-2 cursor-pointer hover:shadow-sm transition"
               style="background: var(--bg-surface); border-color: var(--border-color);"
               onclick="jumpToBookmark(${item.id})">
            <div>
              <div class="flex items-center justify-between text-[11px] mb-1">
                <span class="font-bold" style="color: var(--accent-color);">🔖 책갈피 · ${escapeHtml(item.title)} (${Math.round(item.scroll_percent)}%)</span>
                <span style="color: var(--text-muted);">${escapeHtml((item.created_at || '').slice(0, 16))}</span>
              </div>
              ${
                item.heading_text
                  ? `<div class="text-xs font-bold truncate">📍 ${escapeHtml(item.heading_text)}</div>`
                  : ''
              }
              ${
                item.memo
                  ? `<div class="mt-1.5 px-2.5 py-1.5 rounded-lg text-xs" style="background: var(--bg-secondary);">💬 ${escapeHtml(item.memo)}</div>`
                  : ''
              }
            </div>
          </div>
        `;
      })
      .join('');
  } else {
    bmSection.classList.add('hidden');
  }
}

/* =========================================================
   VIEW 2: Real Hierarchical Folder & File Explorer View
   ========================================================= */
function openFolderExplorer(folderPath, options = {}) {
  if (!state.library) return;
  const cleanPath = String(folderPath || '').replace(/^\/+|\/+$/g, '');
  if (!cleanPath) {
    showDashboard(options);
    return;
  }

  stopTTS();
  flushPendingProgress();

  state.currentView = 'folder';
  state.currentFolderPath = cleanPath;
  state.currentDoc = null;

  // Expand this folder and all its ancestors in the left sidebar tree
  let expandedChanged = false;
  const parts = cleanPath.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('/');
    if (!state.expandedFolders.has(sub)) {
      state.expandedFolders.add(sub);
      expandedChanged = true;
    }
  }

  if (!options.skipHistory) {
    pushNavHistory({ type: 'folder', path: cleanPath });
  }

  document.getElementById('dashboard-view').classList.add('hidden');
  document.getElementById('document-view').classList.add('hidden');
  document.getElementById('folder-explorer-view').classList.remove('hidden');
  document.getElementById('sidebar-right').classList.add('collapsed');
  document.getElementById('top-progress-bar').style.width = '0%';
  hideResumeToast();

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar-left').classList.add('collapsed');
    syncMobileBackdrop();
  }

  document.getElementById('explorer-filter-input').value = '';
  renderFolderExplorerContent();
  if (expandedChanged) {
    renderSidebar();
  } else {
    updateSidebarActiveStates();
  }
  renderStudyTabsBar();
  document.getElementById('reader-viewport').scrollTop = 0;
}

function navigateUpFolder() {
  if (!state.currentFolderPath) {
    showDashboard();
    return;
  }
  const parts = state.currentFolderPath.split('/').filter(Boolean);
  if (parts.length <= 1) {
    showDashboard();
  } else {
    parts.pop();
    openFolderExplorer(parts.join('/'));
  }
}

function renderFolderExplorerContent() {
  if (!state.library || !state.currentFolderPath) return;
  const dirs = state.library.directories || {};
  const dirNode = dirs[state.currentFolderPath];

  if (!dirNode) {
    showDashboard();
    return;
  }

  // 1. Breadcrumbs
  const crumbs = dirNode.breadcrumbs || [];
  const bcContainer = document.getElementById('explorer-breadcrumbs');
  bcContainer.innerHTML = `
    <button type="button" onclick="showDashboard()" class="px-2 py-1 rounded-lg hover:underline" style="color: var(--text-secondary);">
      🏠 전체 볼트
    </button>
    ${crumbs
      .map(
        (c, idx) => `
        <span class="opacity-40">›</span>
        <button type="button"
                onclick="openFolderExplorer('${escapeJsAttr(c.path)}')"
                class="px-2 py-1 rounded-lg hover:underline ${idx === crumbs.length - 1 ? 'font-extrabold' : ''}"
                style="color: ${idx === crumbs.length - 1 ? 'var(--accent-color)' : 'var(--text-primary)'};">
          📁 ${escapeHtml(c.name)}
        </button>
      `
      )
      .join('')}
  `;

  // 2. Folder Header Info
  document.getElementById('explorer-folder-title').textContent = `📂 ${dirNode.name}`;
  const subCount = (dirNode.subfolders || []).length;
  const directCount = (dirNode.direct_docs || []).length;
  const totalCount = dirNode.total_doc_count || 0;
  document.getElementById('explorer-folder-summary').textContent =
    `하위 폴더 ${subCount}개 · 이 폴더 직속 파일 ${directCount}개 (하위 폴더 포함 총 ${totalCount}개 파일 · 완독 ${dirNode.completed_count || 0}개)`;

  const filterQ = (document.getElementById('explorer-filter-input').value || '').trim().toLowerCase();
  const sortBy = document.getElementById('explorer-sort-select').value || 'name';

  // 3. Render Direct Subfolders
  let subfolders = [...(dirNode.subfolders || [])];
  if (filterQ) {
    subfolders = subfolders.filter((sf) => sf.name.toLowerCase().includes(filterQ));
  }

  const sfSection = document.getElementById('explorer-subfolders-section');
  const sfGrid = document.getElementById('explorer-subfolders-grid');
  const sfHeading = document.getElementById('explorer-subfolders-heading');

  if (subfolders.length > 0) {
    sfSection.classList.remove('hidden');
    sfHeading.textContent = `📁 하위 폴더 (${subfolders.length}개) — 폴더를 눌러 안으로 들어가세요`;
    sfGrid.innerHTML = subfolders
      .map((sf) => {
        const pct = sf.total_doc_count > 0 ? Math.round((sf.completed_count / sf.total_doc_count) * 100) : 0;
        return `
          <div onclick="openFolderExplorer('${escapeJsAttr(sf.path)}')"
               class="p-4 rounded-2xl border cursor-pointer transition hover:shadow-md flex flex-col justify-between gap-2 group"
               style="background: var(--bg-surface); border-color: var(--border-color);">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-2xl">📁</span>
                <div class="min-w-0">
                  <div class="font-bold text-sm truncate group-hover:underline">${escapeHtml(sf.name)}</div>
                  <div class="text-[11px]" style="color: var(--text-muted);">
                    ${sf.subfolder_count > 0 ? `폴더 ${sf.subfolder_count}개 · ` : ''}파일 ${sf.total_doc_count}개
                  </div>
                </div>
              </div>
              <span class="text-xs font-bold opacity-60 group-hover:opacity-100" style="color: var(--accent-color);">→</span>
            </div>
            ${
              sf.total_doc_count > 0
                ? `
                <div class="space-y-1 pt-1">
                  <div class="flex justify-between text-[10px]" style="color: var(--text-muted);">
                    <span>완독 ${sf.completed_count}/${sf.total_doc_count}</span>
                    <span>${pct}%</span>
                  </div>
                  <div class="w-full h-1.5 rounded-full overflow-hidden" style="background: var(--bg-secondary);">
                    <div class="h-full" style="width: ${pct}%; background: var(--accent-color);"></div>
                  </div>
                </div>
              `
                : ''
            }
          </div>
        `;
      })
      .join('');
  } else {
    sfSection.classList.add('hidden');
  }

  // 4. Render Direct Files inside this Folder (Exact user filenames!)
  let directDocs = [...(dirNode.direct_docs || [])];
  if (filterQ) {
    directDocs = directDocs.filter(
      (d) =>
        d.title.toLowerCase().includes(filterQ) ||
        (d.subtitle || '').toLowerCase().includes(filterQ) ||
        (d.excerpt || '').toLowerCase().includes(filterQ)
    );
  }

  if (sortBy === 'recent') {
    directDocs.sort((a, b) => String(b.mtime || '').localeCompare(String(a.mtime || '')));
  } else if (sortBy === 'progress') {
    directDocs.sort((a, b) => (b.scroll_percent || 0) - (a.scroll_percent || 0));
  } else {
    directDocs.sort((a, b) => naturalCompare(a.title, b.title));
  }

  const filesHeading = document.getElementById('explorer-files-heading');
  const filesList = document.getElementById('explorer-files-list');
  filesHeading.textContent = `📄 이 폴더에 저장된 파일 (${directDocs.length}개) — 내가 저장한 실제 파일명 그대로 표시됩니다`;

  if (directDocs.length === 0) {
    filesList.innerHTML = `
      <div class="p-8 rounded-2xl border text-center space-y-2" style="background: var(--bg-surface); border-color: var(--border-color);">
        <div class="text-2xl">📂</div>
        <div class="text-xs font-bold">
          ${
            subfolders.length > 0
              ? '이 폴더의 파일들은 위의 하위 폴더들 안에 정리되어 있습니다. 하위 폴더를 클릭해 보세요!'
              : '조건에 맞는 파일이 없습니다.'
          }
        </div>
      </div>
    `;
    return;
  }

  filesList.innerHTML = directDocs
    .map((d) => {
      const pct = Math.round(d.scroll_percent || 0);
      const icon = d.doc_type === 'pdf' ? '📕' : '📄';
      const statusHtml = d.is_completed
        ? `<span class="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-700">✓ 완독</span>`
        : pct > 0
        ? `<span class="px-2.5 py-1 rounded-full text-xs font-bold" style="background: var(--accent-soft); color: var(--accent-color);">${pct}% 읽음</span>`
        : `<span class="px-2.5 py-1 rounded-full text-xs opacity-60" style="background: var(--bg-secondary);">약 ${d.reading_time_min}분</span>`;

      return `
        <div onmouseenter="prefetchDoc('${escapeJsAttr(d.path)}')"
             onclick="openDocument('${escapeJsAttr(d.path)}')"
             class="p-4 rounded-2xl border cursor-pointer transition hover:shadow-md flex flex-col sm:flex-row sm:items-center justify-between gap-3"
             style="background: var(--bg-surface); border-color: var(--border-color);">
          <div class="space-y-1 min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-base">${icon}</span>
              <span class="font-bold text-sm sm:text-base truncate">${escapeHtml(d.title)}</span>
              <span class="text-[11px] opacity-50 flex-shrink-0">(${escapeHtml(d.filename)})</span>
            </div>
            ${
              d.subtitle && state.settings.showSubtitle
                ? `<div class="text-xs font-medium truncate pl-6" style="color: var(--accent-color);">📌 문서 내 제목: ${escapeHtml(d.subtitle)}</div>`
                : ''
            }
            <p class="text-xs line-clamp-1 pl-6 opacity-75">${escapeHtml(d.excerpt || '')}</p>
            <div class="flex flex-wrap items-center gap-2 pl-6 pt-0.5 text-[11px]" style="color: var(--text-muted);">
              <span>📅 ${escapeHtml(d.date)}</span>
              ${d.heading_count ? `<span>· 📑 섹션 ${d.heading_count}개</span>` : ''}
              ${(d.tags || [])
                .slice(0, 4)
                .map((t) => `<span class="px-1.5 py-0.5 rounded text-[10px]" style="background: var(--bg-secondary);">#${escapeHtml(t)}</span>`)
                .join('')}
            </div>
          </div>

          <div class="flex items-center gap-2 flex-shrink-0 self-end sm:self-center">
            ${statusHtml}
            <button type="button"
                    onclick="event.stopPropagation(); openDocInSplitPane('${escapeJsAttr(d.path)}')"
                    class="px-2.5 py-1.5 rounded-xl border text-xs font-semibold hover:opacity-85"
                    style="background: var(--bg-primary); border-color: var(--border-color);"
                    title="우측 비교 참고창에 띄우기">
              ◫ 비교창
            </button>
            <button type="button"
                    class="px-3.5 py-1.5 rounded-xl text-xs font-bold text-white"
                    style="background: var(--accent-color);">
              열기 →
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

/* =========================================================
   Left Sidebar: True Nested Folder Tree / Notes / Tags
   ========================================================= */
function switchSidebarTab(tab) {
  state.sidebarTab = tab;
  ['folders', 'bookmarks', 'tags'].forEach((t) => {
    const btn = document.getElementById(`tab-btn-${t}`);
    if (t === tab) {
      btn.style.borderColor = 'var(--accent-color)';
      btn.style.color = 'var(--accent-color)';
      btn.classList.remove('opacity-70');
    } else {
      btn.style.borderColor = 'transparent';
      btn.style.color = 'var(--text-primary)';
      btn.classList.add('opacity-70');
    }
  });
  const treeCtrl = document.getElementById('sidebar-tree-controls');
  if (treeCtrl) {
    if (tab === 'folders') treeCtrl.classList.remove('hidden');
    else treeCtrl.classList.add('hidden');
  }
  renderSidebar();
}

function toggleFolderExpand(folderPath, event) {
  if (event) event.stopPropagation();
  if (state.expandedFolders.has(folderPath)) {
    state.expandedFolders.delete(folderPath);
  } else {
    state.expandedFolders.add(folderPath);
  }
  renderSidebar();
}

function handleSidebarFolderClick(folderPath) {
  openFolderExplorer(folderPath);
}

function expandAllFolders() {
  if (!state.library || !state.library.directories) return;
  Object.keys(state.library.directories).forEach((p) => state.expandedFolders.add(p));
  renderSidebar();
}

function collapseAllFolders() {
  state.expandedFolders.clear();
  renderSidebar();
}

let searchDebounce = null;
function handleSearchInput(val) {
  state.searchQuery = val.trim();
  const clearBtn = document.getElementById('btn-clear-search');
  if (state.searchQuery) {
    clearBtn.classList.remove('hidden');
  } else {
    clearBtn.classList.add('hidden');
  }
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    if (!state.searchQuery && !state.activeTagFilter) {
      renderSidebar();
      return;
    }
    const res = await apiFetch(
      `/api/search?q=${encodeURIComponent(state.searchQuery)}&tag=${encodeURIComponent(state.activeTagFilter)}`
    );
    renderSearchResultsInSidebar(res.results || []);
  }, 150);
}

function clearSearch() {
  document.getElementById('vault-search-input').value = '';
  state.searchQuery = '';
  state.activeTagFilter = '';
  document.getElementById('btn-clear-search').classList.add('hidden');
  renderSidebar();
}

function filterByTag(tag) {
  state.activeTagFilter = tag;
  document.getElementById('vault-search-input').value = `#${tag}`;
  document.getElementById('btn-clear-search').classList.remove('hidden');
  const left = document.getElementById('sidebar-left');
  left.classList.remove('collapsed');
  apiFetch(`/api/search?tag=${encodeURIComponent(tag)}`).then((res) => {
    renderSearchResultsInSidebar(res.results || []);
  });
}

function renderSearchResultsInSidebar(results) {
  const container = document.getElementById('sidebar-content');
  if (results.length === 0) {
    container.innerHTML = `<div class="p-4 text-xs opacity-60 text-center">검색 결과가 없습니다.</div>`;
    return;
  }
  container.innerHTML = `
    <div class="flex items-center justify-between px-1 pb-2 text-[11px]" style="color: var(--text-muted);">
      <span>🔍 검색 결과 ${results.length}건</span>
      <button type="button" onclick="clearSearch()" class="underline">초기화</button>
    </div>
    ${results
      .map(
        (r) => `
      <div onmouseenter="prefetchDoc('${escapeJsAttr(r.path)}')"
           onclick="openDocument('${escapeJsAttr(r.path)}')"
           class="p-2.5 rounded-xl border cursor-pointer hover:opacity-90 transition space-y-1"
           style="background: var(--bg-surface); border-color: var(--border-color);">
        <div class="text-[10px] font-bold truncate" style="color: var(--accent-color);">📂 ${escapeHtml(r.folder || r.top_folder)}</div>
        <div class="text-xs font-bold truncate">📄 ${escapeHtml(r.title)}</div>
        <div class="text-[11px] line-clamp-2 opacity-75">${escapeHtml(r.match_snippet || '')}</div>
      </div>
    `
      )
      .join('')}
  `;
}

function updateSidebarActiveStates() {
  if (state.sidebarTab !== 'folders') return;
  const activeFolder = state.currentView === 'folder' ? state.currentFolderPath : '';
  const activeDoc = state.currentView === 'doc' && state.currentDoc ? state.currentDoc.path : '';

  document.querySelectorAll('.tree-folder-row').forEach((el) => {
    if (el.dataset.folderPath === activeFolder) {
      el.classList.add('active-folder');
    } else {
      el.classList.remove('active-folder');
    }
  });

  document.querySelectorAll('.tree-doc-row').forEach((el) => {
    if (el.dataset.docPath === activeDoc) {
      el.classList.add('active-doc');
    } else {
      el.classList.remove('active-doc');
    }
  });
}

function renderRecursiveTreeHTML(node) {
  const isOpen = state.expandedFolders.has(node.path);
  const isActiveFolder = state.currentView === 'folder' && state.currentFolderPath === node.path;
  const childFolders = node.children || [];
  const directDocs = node.direct_docs || [];

  const childrenHtml = isOpen
    ? `
      <div class="tree-children-guide space-y-0.5 mt-0.5">
        ${childFolders.map((cf) => renderRecursiveTreeHTML(cf)).join('')}
        ${directDocs
          .map((d) => {
            const isActiveDoc = state.currentView === 'doc' && state.currentDoc && state.currentDoc.path === d.path;
            const pct = Math.round(d.scroll_percent || 0);
            const badge = d.is_completed
              ? `<span class="text-emerald-600 font-bold text-[10px]">✓</span>`
              : pct > 0
              ? `<span class="text-[10px] font-bold" style="color: var(--accent-color);">${pct}%</span>`
              : '';
            const icon = d.doc_type === 'pdf' ? '📕' : '📄';
            return `
              <div data-doc-path="${escapeHtml(d.path)}"
                   onmouseenter="prefetchDoc('${escapeJsAttr(d.path)}')"
                   onclick="openDocument('${escapeJsAttr(d.path)}')"
                   class="tree-doc-row ${isActiveDoc ? 'active-doc' : ''}"
                   title="${escapeHtml(d.title)}">
                <span class="truncate flex items-center gap-1.5">
                  <span class="text-[11px]">${icon}</span>
                  <span class="truncate">${escapeHtml(d.title)}</span>
                </span>
                <span class="tree-doc-badge flex-shrink-0">${badge}</span>
              </div>
            `;
          })
          .join('')}
        ${
          childFolders.length === 0 && directDocs.length === 0
            ? `<div class="text-[11px] opacity-45 py-1 pl-2">빈 폴더</div>`
            : ''
        }
      </div>
    `
    : '';

  return `
    <div>
      <div data-folder-path="${escapeHtml(node.path)}"
           class="tree-folder-row ${isActiveFolder ? 'active-folder' : ''}"
           onclick="handleSidebarFolderClick('${escapeJsAttr(node.path)}')">
        <div class="flex items-center gap-1.5 min-w-0 flex-1">
          <span onclick="toggleFolderExpand('${escapeJsAttr(node.path)}', event)"
                class="w-4 text-center text-[11px] opacity-75 hover:opacity-100"
                title="트리에만 펼치기/접기">
            ${isOpen ? '▾' : '▸'}
          </span>
          <span class="text-sm">${isOpen ? '📂' : '📁'}</span>
          <span class="truncate">${escapeHtml(node.name)}</span>
        </div>
        <span class="text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
              style="background: var(--bg-primary); color: var(--text-muted);">
          ${node.total_doc_count}
        </span>
      </div>
      ${childrenHtml}
    </div>
  `;
}

function renderSidebar() {
  if (!state.library) return;
  const container = document.getElementById('sidebar-content');

  if (state.sidebarTab === 'folders') {
    const tree = state.library.folder_tree || [];
    if (tree.length === 0) {
      container.innerHTML = `<div class="p-4 text-xs opacity-60 text-center">표시할 폴더가 없습니다.</div>`;
      return;
    }
    container.innerHTML = tree.map((rootNode) => renderRecursiveTreeHTML(rootNode)).join('');
    return;
  }

  if (state.sidebarTab === 'bookmarks') {
    const hls = state.library.highlights || [];
    const bms = state.library.bookmarks || [];
    if (hls.length === 0 && bms.length === 0) {
      container.innerHTML = `
        <div class="p-6 text-center space-y-2 text-xs opacity-75">
          <div class="text-2xl">🖍️</div>
          <div class="font-bold">저장된 형광펜·책갈피가 없습니다.</div>
          <div class="text-[11px]">본문에서 기억할 문장을 마우스로 드래그해 형광펜을 칠하거나 상단 <b>[🔖 책갈피]</b>를 눌러보세요!</div>
        </div>
      `;
      return;
    }

    let html = `
      <button type="button" onclick="openFlashcardModal()"
              class="w-full py-2 mb-2 rounded-xl text-xs font-bold text-white shadow-sm"
              style="background: var(--accent-color);">
        🃏 전체 암기 플래시카드로 복습하기 (${hls.length + bms.length}장)
      </button>
    `;

    html += hls
      .map(
        (h) => `
        <div class="p-3 rounded-xl border space-y-1.5" style="background: var(--bg-surface); border-color: var(--border-color);">
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-bold cursor-pointer hover:underline truncate" style="color: var(--accent-color);"
                  onclick="openDocument('${escapeJsAttr(h.doc_path)}', { targetPercent: ${h.scroll_percent || 0} })">
              🖍️ ${escapeHtml(h.title)}
            </span>
            <button type="button" onclick="deleteHighlightById(${h.id})" class="opacity-50 hover:opacity-100 text-xs">🗑️</button>
          </div>
          <div onclick="openDocument('${escapeJsAttr(h.doc_path)}', { targetPercent: ${h.scroll_percent || 0} })"
               class="cursor-pointer space-y-1">
            <div class="p-2 rounded-lg text-xs font-medium" style="background: var(--hl-bg);">"${escapeHtml(h.selected_text)}"</div>
            ${h.note ? `<div class="text-xs opacity-85">💬 ${escapeHtml(h.note)}</div>` : ''}
          </div>
        </div>
      `
      )
      .join('');

    html += bms
      .map(
        (b) => `
        <div class="p-3 rounded-xl border space-y-1.5" style="background: var(--bg-surface); border-color: var(--border-color);">
          <div class="flex items-center justify-between text-[11px]">
            <span class="font-bold cursor-pointer hover:underline truncate" style="color: var(--accent-color);" onclick="jumpToBookmark(${b.id})">
              🔖 ${escapeHtml(b.title)} (${Math.round(b.scroll_percent)}%)
            </span>
            <button type="button" onclick="deleteBookmarkById(${b.id})" class="opacity-50 hover:opacity-100 text-xs">🗑️</button>
          </div>
          <div onclick="jumpToBookmark(${b.id})" class="cursor-pointer space-y-1">
            ${b.heading_text ? `<div class="text-[11px] font-semibold truncate">📍 ${escapeHtml(b.heading_text)}</div>` : ''}
            ${b.memo ? `<div class="p-2 rounded-lg text-xs" style="background: var(--bg-secondary);">💬 ${escapeHtml(b.memo)}</div>` : ''}
          </div>
        </div>
      `
      )
      .join('');

    container.innerHTML = html;
    return;
  }

  if (state.sidebarTab === 'tags') {
    const tags = state.library.tags || [];
    if (tags.length === 0) {
      container.innerHTML = `<div class="p-4 text-xs opacity-60 text-center">추출된 #태그가 없습니다.</div>`;
      return;
    }
    container.innerHTML = `
      <div class="flex flex-wrap gap-1.5 p-1">
        ${tags
          .map(
            (t) => `
          <button type="button"
                  onclick="filterByTag('${escapeJsAttr(t.tag)}')"
                  class="px-2.5 py-1 rounded-full text-xs border transition hover:opacity-90"
                  style="background: var(--bg-surface); border-color: var(--border-color);">
            #${escapeHtml(t.tag)} <span class="opacity-60 text-[10px]">(${t.count})</span>
          </button>
        `
          )
          .join('')}
      </div>
    `;
  }
}

/* =========================================================
   Opening & Rendering an Obsidian Document as E-Book
   ========================================================= */
async function openDocument(docPath, options = {}) {
  stopTTS();
  flushPendingProgress();

  // Switch views immediately so user never wonders if a click registered!
  document.getElementById('dashboard-view').classList.add('hidden');
  document.getElementById('folder-explorer-view').classList.add('hidden');
  document.getElementById('document-view').classList.remove('hidden');

  if (window.innerWidth <= 768) {
    document.getElementById('sidebar-left').classList.add('collapsed');
  }
  if (window.innerWidth <= 1024) {
    document.getElementById('sidebar-right').classList.add('collapsed');
  }
  syncMobileBackdrop();

  // Fast Path: Instant 0ms cache hit from state.docCache
  let rawDoc = state.docCache.get(docPath);
  if (!rawDoc) {
    // Show instant skeleton header from state.library while fetching
    const previewMeta = (state.library && state.library.documents || []).find((d) => d.path === docPath);
    if (previewMeta) {
      document.getElementById('doc-folder-badge').textContent = `📂 ${previewMeta.folder || previewMeta.top_folder || 'Root'}`;
      document.getElementById('doc-main-title').textContent = previewMeta.title;
    } else {
      document.getElementById('doc-main-title').textContent = docPath.split('/').pop() || docPath;
    }
    document.getElementById('ebook-article').innerHTML = `
      <div class="py-12 text-center space-y-3 opacity-75">
        <div class="text-2xl animate-pulse">📖</div>
        <div class="text-sm font-bold">문서를 불러오는 중입니다...</div>
      </div>
    `;
    const inFlight = state.prefetchInFlight.get(docPath);
    rawDoc = inFlight ? await inFlight : await apiFetch(`/api/doc?path=${encodeURIComponent(docPath)}`);
    if (rawDoc && rawDoc.path) {
      state.docCache.set(rawDoc.path, rawDoc);
      ObsiBookIDB.saveDocsBatch([rawDoc]);
    }
  }

  const doc = enrichDocWithLibraryState(rawDoc);
  state.currentView = 'doc';
  state.currentDoc = doc;
  state.currentFolderPath = doc.folder || doc.top_folder || '';
  state.lastReadTick = Date.now();

  // Auto-expand ancestor folders in sidebar tree
  let expandedChanged = false;
  if (doc.folder) {
    const parts = doc.folder.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if (!state.expandedFolders.has(sub)) {
        state.expandedFolders.add(sub);
        expandedChanged = true;
      }
    }
  }

  if (!options.skipHistory) {
    pushNavHistory({ type: 'doc', path: doc.path });
  }

  addOrActivateStudyTab(doc);

  // Interactive Folder Breadcrumbs at Top of Document
  const crumbs = doc.breadcrumbs || [];
  document.getElementById('doc-interactive-breadcrumbs').innerHTML = `
    <button type="button" onclick="showDashboard()" class="px-2 py-0.5 rounded hover:underline" style="color: var(--text-secondary);">
      🏠 홈
    </button>
    ${crumbs
      .map(
        (c) => `
        <span class="opacity-40">›</span>
        <button type="button"
                onclick="openFolderExplorer('${escapeJsAttr(c.path)}')"
                class="px-2 py-0.5 rounded hover:underline font-bold"
                style="color: var(--accent-color);">
          📁 ${escapeHtml(c.name)}
        </button>
      `
      )
      .join('')}
  `;

  // Sibling Document Quick Selector (Switch to another file in the same folder with 1 click!)
  const siblings = doc.sibling_docs || [];
  const sibSelect = document.getElementById('doc-sibling-select');
  sibSelect.innerHTML = siblings
    .map(
      (s) => `
      <option value="${escapeHtml(s.path)}" ${s.path === doc.path ? 'selected' : ''}>
        📄 ${escapeHtml(s.title)}
      </option>
    `
    )
    .join('');

  // Metadata Header Card (Exact Filename as Main Title!)
  document.getElementById('doc-folder-badge').textContent = `📂 ${doc.folder || doc.top_folder || 'Root'}`;
  document.getElementById('doc-main-title').textContent = doc.title;

  const subEl = document.getElementById('doc-subtitle-text');
  if (doc.subtitle && doc.subtitle !== doc.title && state.settings.showSubtitle) {
    subEl.textContent = `📌 문서 내 제목: ${doc.subtitle}`;
    subEl.classList.remove('hidden');
  } else {
    subEl.classList.add('hidden');
  }

  document.getElementById('doc-meta-info').innerHTML = `
    <span>📄 실제 파일명: <b>${escapeHtml(doc.filename)}</b></span>
    <span>·</span>
    <span>📅 ${escapeHtml(doc.date)}</span>
    <span>·</span>
    <span>⏱️ 약 ${doc.reading_time_min}분 분량</span>
    ${doc.char_count ? `<span>· 📝 ${Number(doc.char_count).toLocaleString()}자</span>` : ''}
  `;

  // Frontmatter Pills
  const fm = doc.frontmatter || {};
  const ignoredKeys = new Set(['title', 'date', 'tags', 'tag']);
  const fmEntries = Object.entries(fm).filter(([k, v]) => !ignoredKeys.has(k) && v !== null && v !== '');
  document.getElementById('doc-frontmatter-pills').innerHTML = fmEntries
    .map(
      ([k, v]) => `
      <span class="px-2.5 py-1 rounded-lg text-[11px] border" style="background: var(--bg-primary); border-color: var(--border-color);">
        <b class="opacity-70">${escapeHtml(k)}:</b> ${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : v)}
      </span>
    `
    )
    .join('');

  // Tags
  document.getElementById('doc-tags-row').innerHTML = (doc.tags || [])
    .map(
      (t) => `
      <button type="button" onclick="filterByTag('${escapeJsAttr(t)}')"
              class="px-2.5 py-0.5 rounded-full text-[11px] font-semibold"
              style="background: var(--accent-soft); color: var(--accent-color);">
        #${escapeHtml(t)}
      </button>
    `
    )
    .join('');

  updateCompleteButtonUI(Boolean(doc.progress && doc.progress.is_completed));

  // Render Document Content (Markdown or PDF)
  if (doc.doc_type === 'pdf') {
    state.cachedHeadingEls = [];
    const article = document.getElementById('ebook-article');
    article.innerHTML = `
      <div class="rounded-2xl overflow-hidden border shadow-sm" style="border-color: var(--border-color); background: var(--bg-surface);">
        <div class="p-3 border-b flex items-center justify-between text-xs" style="border-color: var(--border-color);">
          <span class="font-bold">📕 PDF 문서 뷰어: ${escapeHtml(doc.filename)}</span>
          <a href="${escapeHtml(doc.asset_url)}" target="_blank" rel="noopener" class="font-bold underline" style="color: var(--accent-color);">새 탭에서 크게 열기 ↗</a>
        </div>
        <iframe src="${escapeHtml(doc.asset_url)}" class="w-full h-[78vh] border-0"></iframe>
      </div>
    `;
  } else {
    renderMarkdownArticle(doc);
  }

  // Populate Study Scratchpad Note
  const noteTextarea = document.getElementById('study-note-textarea');
  if (noteTextarea) {
    noteTextarea.value = (doc.study_note && doc.study_note.content) || '';
    document.getElementById('study-note-status').textContent =
      doc.study_note && doc.study_note.updated_at
        ? `마지막 저장: ${doc.study_note.updated_at}`
        : '이 문서의 요약 노트를 작성해 보세요.';
  }

  // Render Right Sidebar (TOC & In-Doc Highlights/Bookmarks)
  renderRightSidebar(doc);

  // Render Prev / Next Chapter Navigation Cards & Prefetch Neighbors
  renderPrevNextNav(doc);
  if (doc.prev_doc && doc.prev_doc.path) prefetchDoc(doc.prev_doc.path);
  if (doc.next_doc && doc.next_doc.path) prefetchDoc(doc.next_doc.path);

  // Highlight active doc in left sidebar without full rebuild unless needed
  if (expandedChanged) {
    renderSidebar();
  } else {
    updateSidebarActiveStates();
  }

  // Re-apply Cloze mode if currently active
  if (state.clozeActive) {
    applyClozeTargetsInArticle();
  } else {
    updateClozeToolbarUI();
  }

  // Restore scroll position
  const viewport = document.getElementById('reader-viewport');
  state.suppressScrollSave = true;
  const savedPct = doc.progress ? Number(doc.progress.scroll_percent || 0) : 0;

  if (options.targetHeadingId) {
    setTimeout(() => {
      scrollToHeading(options.targetHeadingId);
      state.suppressScrollSave = false;
    }, 50);
  } else if (typeof options.targetPercent === 'number') {
    setTimeout(() => {
      scrollToPercentage(options.targetPercent);
      state.suppressScrollSave = false;
    }, 50);
  } else if (savedPct > 1.5 && savedPct < 98 && (state.settings.autoRestoreScroll || options.restoreScroll)) {
    setTimeout(() => {
      scrollToPercentage(savedPct);
      showResumeToast(savedPct, doc.progress.heading_text, true);
      state.suppressScrollSave = false;
    }, 60);
  } else {
    viewport.scrollTop = 0;
    updateScrollIndicators(0);
    if (savedPct > 1.5 && savedPct < 98) {
      showResumeToast(savedPct, doc.progress.heading_text, false);
    } else {
      hideResumeToast();
    }
    setTimeout(() => {
      state.suppressScrollSave = false;
    }, 80);
  }
}

function openCurrentDocFolder() {
  if (state.currentDoc && (state.currentDoc.folder || state.currentDoc.top_folder)) {
    openFolderExplorer(state.currentDoc.folder || state.currentDoc.top_folder);
  } else if (state.currentFolderPath) {
    openFolderExplorer(state.currentFolderPath);
  } else {
    showDashboard();
  }
}

function renderMarkdownArticle(doc) {
  const article = document.getElementById('ebook-article');
  const rawContent = doc.content || '';

  prewarmDocImages(rawContent);
  article.innerHTML = renderObsidianMarkdownToHtml(rawContent);
  enhanceArticleImages(article);

  // 1. Assign Heading IDs, Sync TOC Slugs, Bookmark Pin Button, and Section Collapse Button
  const headingEls = Array.from(article.querySelectorAll('h1, h2, h3, h4'));
  state.cachedHeadingEls = headingEls;
  const seenSlugs = {};
  const syncedHeadings = [];

  headingEls.forEach((hEl) => {
    const cleanText = hEl.textContent.trim();
    const level = Number(hEl.tagName.slice(1)) || 2;
    const base = slugifyHeading(cleanText);
    const count = seenSlugs[base] || 0;
    seenSlugs[base] = count + 1;
    const slug = count > 0 ? `${base}-${count}` : base;
    hEl.id = slug;
    syncedHeadings.push({ level, text: cleanText, id: slug });

    const btnGroup = document.createElement('span');
    btnGroup.className = 'heading-action-group';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'heading-pin-btn';
    pinBtn.title = '이 섹션 책갈피 추가';
    pinBtn.textContent = '🔖 책갈피';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBookmarkModal({
        headingId: slug,
        headingText: cleanText,
      });
    });

    const foldBtn = document.createElement('button');
    foldBtn.type = 'button';
    foldBtn.className = 'heading-pin-btn';
    foldBtn.title = '이 섹션 내용 접기/펼치기';
    foldBtn.textContent = '▾ 접기';
    foldBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleHeadingFold(hEl, foldBtn);
    });

    btnGroup.appendChild(pinBtn);
    btnGroup.appendChild(foldBtn);
    hEl.appendChild(btnGroup);
  });

  doc.headings = syncedHeadings;

  // 2. Transform Obsidian Callouts: > [!NOTE] Title
  const blockquotes = article.querySelectorAll('blockquote');
  const calloutIcons = {
    note: '📝',
    info: 'ℹ️',
    tip: '💡',
    hint: '💡',
    important: '✨',
    success: '✅',
    warning: '⚠️',
    caution: '🚨',
    danger: '⛔',
    example: '📌',
    quote: '💬',
  };
  blockquotes.forEach((bq) => {
    const firstP = bq.querySelector('p');
    if (!firstP) return;
    const m = firstP.innerHTML.match(/^\s*\[!([A-Za-z]+)\][+-]?\s*(.*)/s);
    if (m) {
      const type = m[1].toLowerCase();
      const restContent = m[2];
      const lines = restContent.split(/<br\s*\/?>|\n/);
      const titleLine = lines[0].trim() || type.toUpperCase();
      const bodyLines = lines.slice(1).join('<br>');

      const calloutDiv = document.createElement('div');
      calloutDiv.className = `obsidian-callout callout-${type}`;
      const icon = calloutIcons[type] || '📌';

      firstP.innerHTML = bodyLines;
      calloutDiv.innerHTML = `<div class="obsidian-callout-title"><span>${icon}</span><span>${titleLine}</span></div>`;
      if (bodyLines.trim()) {
        calloutDiv.appendChild(firstP);
      } else {
        firstP.remove();
      }
      while (bq.firstChild) {
        calloutDiv.appendChild(bq.firstChild);
      }
      bq.replaceWith(calloutDiv);
    }
  });

  // 3. Enhance Code & Prompt Blocks with Copy Button & Deferred Highlighting/Mermaid
  const codeBlocks = article.querySelectorAll('pre > code');
  const codeBlocksToHighlight = [];
  let hasMermaid = false;

  codeBlocks.forEach((codeEl) => {
    const pre = codeEl.parentElement;
    const classList = Array.from(codeEl.classList);
    const langClass = classList.find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.replace('language-', '') : 'text';

    if (lang === 'mermaid') {
      const mermaidDiv = document.createElement('div');
      mermaidDiv.className = 'mermaid my-6 flex justify-center p-4 rounded-xl border';
      mermaidDiv.style.background = 'var(--bg-surface)';
      mermaidDiv.style.borderColor = 'var(--border-color)';
      mermaidDiv.textContent = codeEl.textContent;
      pre.replaceWith(mermaidDiv);
      hasMermaid = true;
      return;
    }

    codeBlocksToHighlight.push(codeEl);

    const wrapper = document.createElement('div');
    wrapper.className = 'code-wrapper';
    const header = document.createElement('div');
    header.className = 'code-header';
    header.innerHTML = `<span>${escapeHtml(lang.toUpperCase())}</span>`;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-code-btn';
    copyBtn.innerHTML = '📋 복사';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(codeEl.textContent);
      copyBtn.innerHTML = '✓ 복사 완료!';
      setTimeout(() => {
        copyBtn.innerHTML = '📋 복사';
      }, 1800);
    });
    header.appendChild(copyBtn);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });

  if (codeBlocksToHighlight.length > 0 || hasMermaid) {
    requestAnimationFrame(() => {
      if (window.hljs && codeBlocksToHighlight.length > 0) {
        codeBlocksToHighlight.forEach((el) => {
          try {
            hljs.highlightElement(el);
          } catch (e) {}
        });
      }
      if (hasMermaid && window.mermaid) {
        mermaid.run({ querySelector: '.mermaid' }).catch(() => {});
      }
    });
  }

  // 4. Make Checkboxes Interactive for Study Checklists
  article.querySelectorAll('input[type="checkbox"]').forEach((chk) => {
    chk.removeAttribute('disabled');
    chk.classList.add('cursor-pointer', 'accent-emerald-600');
  });

  // 5. Wrap Tables in Responsive Wrapper
  article.querySelectorAll('table').forEach((tbl) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll-wrapper';
    tbl.parentNode.insertBefore(wrapper, tbl);
    wrapper.appendChild(tbl);
  });

  // 6. Intercept WikiLinks (#doc:...) & External Links
  article.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#doc:')) {
      const rawTarget = href.slice(5);
      const [docPart, anchorPart] = rawTarget.split('#');
      const targetDocPath = decodeURIComponent(docPart);
      a.addEventListener('mouseenter', () => prefetchDoc(targetDocPath));
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openDocument(targetDocPath, {
          targetHeadingId: anchorPart || undefined,
        });
      });
    } else if (href.startsWith('#unresolved:')) {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const name = decodeURIComponent(href.slice(12));
        document.getElementById('vault-search-input').value = name;
        handleSearchInput(name);
      });
    } else if (href.startsWith('http://') || href.startsWith('https://')) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // 7. Highlight user-saved highlights inside the rendered DOM
  applySavedHighlightsToDOM(doc.highlights || []);

  // 8. Setup Paginated Chapter Mode if enabled
  setupChapterPagination();
}

function toggleHeadingFold(headingEl, btnEl) {
  const level = Number(headingEl.tagName.slice(1));
  let next = headingEl.nextElementSibling;
  let isFolding = btnEl.textContent.includes('▾');
  btnEl.textContent = isFolding ? '▸ 펼치기' : '▾ 접기';

  while (next) {
    if (/^H[1-4]$/.test(next.tagName)) {
      const nextLv = Number(next.tagName.slice(1));
      if (nextLv <= level) break;
    }
    if (isFolding) {
      next.classList.add('section-folded-hidden');
    } else {
      next.classList.remove('section-folded-hidden');
    }
    next = next.nextElementSibling;
  }
}

/* =========================================================
   🧠 Active Recall Cloze Mode (빈칸 가리기 암기 모드)
   ========================================================= */
function toggleClozeMode() {
  state.clozeActive = !state.clozeActive;
  if (state.clozeActive) {
    applyClozeTargetsInArticle();
  } else {
    clearClozeTargetsInArticle();
  }
  updateClozeToolbarUI();
}

function applyClozeTargetsInArticle() {
  const article = document.getElementById('ebook-article');
  if (!article) return;
  article.classList.add('cloze-mode-active');

  const candidates = article.querySelectorAll('strong, b, mark, .obs-hl, p > code, li > code, td > code');
  let count = 0;
  candidates.forEach((el) => {
    if (el.closest('h1, h2, h3, h4, .obsidian-callout-title, pre')) return;
    const text = el.textContent.trim();
    if (text.length < 2) return;

    el.classList.add('cloze-target', 'cloze-hidden');
    el.classList.remove('cloze-revealed');
    el.dataset.clozeSolved = '0';

    if (!el.dataset.clozeBound) {
      el.dataset.clozeBound = '1';
      el.addEventListener('click', (e) => {
        if (!state.clozeActive) return;
        e.stopPropagation();
        if (el.classList.contains('cloze-hidden')) {
          el.classList.remove('cloze-hidden');
          el.classList.add('cloze-revealed');
          if (el.dataset.clozeSolved === '0') {
            el.dataset.clozeSolved = '1';
            state.clozeRevealedCount += 1;
            updateClozeToolbarUI();
            showXpToast('🧠 암기 확인! +10 XP');
            apiFetch('/api/study/log', {
              method: 'POST',
              body: JSON.stringify({ add_quiz: 1, add_xp: 10 }),
            })
              .then((res) => {
                if (res.study_stats) updateStudyGamificationUI(res.study_stats);
              })
              .catch(() => {});
          }
        } else {
          el.classList.remove('cloze-revealed');
          el.classList.add('cloze-hidden');
        }
      });
    }
    count += 1;
  });

  state.clozeTotal = count;
  state.clozeRevealedCount = 0;
  updateClozeToolbarUI();
}

function clearClozeTargetsInArticle() {
  const article = document.getElementById('ebook-article');
  if (!article) return;
  article.classList.remove('cloze-mode-active');
  article.querySelectorAll('.cloze-target').forEach((el) => {
    el.classList.remove('cloze-hidden', 'cloze-revealed');
  });
}

function revealAllCloze(show) {
  const article = document.getElementById('ebook-article');
  if (!article) return;
  article.querySelectorAll('.cloze-target').forEach((el) => {
    if (show) {
      el.classList.remove('cloze-hidden');
      el.classList.add('cloze-revealed');
    } else {
      el.classList.remove('cloze-revealed');
      el.classList.add('cloze-hidden');
    }
  });
}

function updateClozeToolbarUI() {
  const hdrBtn = document.getElementById('btn-cloze-header');
  const barBtn = document.getElementById('btn-cloze-bar');
  const ctrlGroup = document.getElementById('cloze-controls-group');
  const scoreBadge = document.getElementById('cloze-score-badge');

  if (state.clozeActive) {
    if (hdrBtn) {
      hdrBtn.style.background = 'var(--accent-color)';
      hdrBtn.style.color = '#ffffff';
    }
    if (barBtn) {
      barBtn.textContent = '🧠 빈칸 암기 가림막: ON';
      barBtn.style.background = 'var(--accent-color)';
      barBtn.style.color = '#ffffff';
    }
    if (ctrlGroup) {
      ctrlGroup.classList.remove('hidden');
      ctrlGroup.classList.add('flex');
    }
    if (scoreBadge) {
      scoreBadge.textContent = `🎯 암기 확인 ${state.clozeRevealedCount} / ${state.clozeTotal}`;
    }
  } else {
    if (hdrBtn) {
      hdrBtn.style.background = 'var(--bg-secondary)';
      hdrBtn.style.color = 'var(--text-primary)';
    }
    if (barBtn) {
      barBtn.textContent = '🧠 빈칸 암기 가림막: OFF (클릭 시 핵심용어 가리기)';
      barBtn.style.background = 'var(--bg-primary)';
      barBtn.style.color = 'var(--text-primary)';
    }
    if (ctrlGroup) {
      ctrlGroup.classList.add('hidden');
      ctrlGroup.classList.remove('flex');
    }
  }
}

/* =========================================================
   🖍️ Text Selection Highlighter & 🃏 Flashcard Quiz Modal
   ========================================================= */
function setupTextSelectionToolbar() {
  const toolbar = document.getElementById('selection-toolbar');
  document.addEventListener('mouseup', (e) => {
    if (toolbar.contains(e.target)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      const article = document.getElementById('ebook-article');
      if (
        !state.currentDoc ||
        !text ||
        text.length < 2 ||
        text.length > 600 ||
        !article ||
        !sel.anchorNode ||
        !article.contains(sel.anchorNode)
      ) {
        toolbar.style.display = 'none';
        return;
      }
      state.pendingSelectionText = text;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      toolbar.style.display = 'flex';
      const top = Math.max(60, rect.top - 46);
      const left = Math.max(12, Math.min(window.innerWidth - 260, rect.left));
      toolbar.style.top = `${top}px`;
      toolbar.style.left = `${left}px`;
    }, 20);
  });
}

async function saveSelectionHighlight(color = 'yellow', openMemoModal = false) {
  const toolbar = document.getElementById('selection-toolbar');
  toolbar.style.display = 'none';
  const text = state.pendingSelectionText;
  if (!state.currentDoc || !text) return;

  window.getSelection()?.removeAllRanges();

  if (openMemoModal) {
    openBookmarkModal({
      snippet: text,
      isHighlightCard: true,
      hlColor: color,
    });
    return;
  }

  const res = await apiFetch('/api/highlights', {
    method: 'POST',
    body: JSON.stringify({
      doc_path: state.currentDoc.path,
      selected_text: text,
      title: state.currentDoc.title,
      folder: state.currentDoc.folder || state.currentDoc.top_folder,
      note: '',
      color,
      heading_id: state.currentHeadingId,
      heading_text: state.currentHeadingText,
      scroll_percent: state.currentScrollPercent,
      is_flashcard: true,
    }),
  });

  if (res.highlight) {
    state.currentDoc.highlights = [res.highlight, ...(state.currentDoc.highlights || [])];
    if (state.library) {
      state.library.highlights = [res.highlight, ...(state.library.highlights || [])];
      state.library.stats.total_highlights = state.library.highlights.length;
      updateHeaderAndStats();
      if (state.sidebarTab === 'bookmarks') renderSidebar();
    }
    applySavedHighlightsToDOM([res.highlight]);
    renderRightSidebar(state.currentDoc);
    showXpToast('🖍️ 형광펜 & 암기카드 저장! +20 XP');
    if (res.study_stats) updateStudyGamificationUI(res.study_stats);
  }
}

function applySavedHighlightsToDOM(highlights) {
  const article = document.getElementById('ebook-article');
  if (!article || !highlights || highlights.length === 0) return;

  highlights.forEach((hl) => {
    const target = (hl.selected_text || '').trim();
    if (target.length < 3) return;
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement && node.parentElement.closest('pre, code, mark, .user-hl-span')) continue;
      const idx = node.nodeValue.indexOf(target);
      if (idx !== -1) {
        const span = document.createElement('span');
        span.className = `user-hl-span user-hl-${hl.color || 'yellow'}`;
        span.title = hl.note ? `💬 ${hl.note}` : '내가 칠한 형광펜';
        const matchedNode = node.splitText(idx);
        matchedNode.splitText(target.length);
        span.textContent = matchedNode.nodeValue;
        matchedNode.parentNode.replaceChild(span, matchedNode);
        break;
      }
    }
  });
}

async function deleteHighlightById(id) {
  await apiFetch(`/api/highlights/${id}`, { method: 'DELETE' });
  if (state.currentDoc) {
    state.currentDoc.highlights = (state.currentDoc.highlights || []).filter((h) => h.id !== id);
    renderRightSidebar(state.currentDoc);
  }
  if (state.library) {
    state.library.highlights = (state.library.highlights || []).filter((h) => h.id !== id);
    state.library.stats.total_highlights = state.library.highlights.length;
    updateHeaderAndStats();
    if (state.sidebarTab === 'bookmarks') renderSidebar();
    if (state.currentView === 'dashboard') renderDashboard();
  }
}

function openFlashcardModal() {
  if (!state.library) return;
  const hls = (state.library.highlights || []).map((h) => ({
    id: h.id,
    type: 'hl',
    doc_path: h.doc_path,
    title: h.title,
    folder: h.folder,
    front: h.note ? `❓ 질문/주제: ${h.note}` : `📍 [${h.title}] ${h.heading_text || '핵심 문장 빈칸 맞추기'}`,
    back: h.selected_text,
    subnote: h.note || '',
    scroll_percent: h.scroll_percent,
    mastered: Boolean(h.mastered),
  }));

  const bms = (state.library.bookmarks || [])
    .filter((b) => b.memo || b.heading_text)
    .map((b) => ({
      id: b.id,
      type: 'bm',
      doc_path: b.doc_path,
      title: b.title,
      folder: b.folder,
      front: `🔖 [${b.title}] ${b.heading_text || '책갈피 핵심 포인트'}`,
      back: b.memo || b.heading_text,
      subnote: '',
      scroll_percent: b.scroll_percent,
      mastered: false,
    }));

  state.flashcards = [...hls, ...bms];
  state.flashcardIdx = 0;
  state.flashcardFlipped = false;

  const modal = document.getElementById('flashcard-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  renderFlashcardBody();
}

function closeFlashcardModal() {
  const modal = document.getElementById('flashcard-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function renderFlashcardBody() {
  const box = document.getElementById('flashcard-body');
  const cards = state.flashcards;
  if (cards.length === 0) {
    box.innerHTML = `
      <div class="p-8 text-center space-y-3">
        <div class="text-3xl">🃏</div>
        <div class="text-sm font-bold">아직 등록된 암기 카드(형광펜·책갈피)가 없습니다!</div>
        <p class="text-xs opacity-75">
          문서를 읽다가 기억하고 싶은 문장을 마우스로 드래그해 <b>[🟡 형광펜]</b>이나 <b>[🃏 암기카드+메모]</b>를 누르면 자동으로 나만의 복습 카드가 만들어집니다.
        </p>
      </div>
    `;
    return;
  }

  const card = cards[state.flashcardIdx];
  box.innerHTML = `
    <div class="space-y-4">
      <div class="flex items-center justify-between text-xs">
        <span class="px-2.5 py-1 rounded-lg font-bold" style="background: var(--accent-soft); color: var(--accent-color);">
          카드 ${state.flashcardIdx + 1} / ${cards.length} · 📄 ${escapeHtml(card.title)}
        </span>
        <button type="button"
                onclick="closeFlashcardModal(); openDocument('${escapeJsAttr(card.doc_path)}', { targetPercent: ${card.scroll_percent || 0} })"
                class="text-xs font-bold underline" style="color: var(--accent-color);">
          원문 보러가기 ↗
        </button>
      </div>

      <!-- Interactive Flip Card -->
      <div onclick="flipCurrentFlashcard()"
           class="p-7 rounded-2xl border-2 cursor-pointer transition min-h-[170px] flex flex-col items-center justify-center text-center space-y-3"
           style="background: var(--bg-primary); border-color: ${state.flashcardFlipped ? '#10b981' : 'var(--accent-color)'};">
        <div class="text-[11px] font-bold uppercase tracking-wider opacity-60">
          ${state.flashcardFlipped ? '💡 정답 / 원문 핵심 내용' : '❓ 앞면 (클릭하면 정답이 뒤집힙니다)'}
        </div>
        <div class="text-base sm:text-lg font-bold leading-relaxed">
          ${escapeHtml(state.flashcardFlipped ? card.back : card.front)}
        </div>
        ${
          state.flashcardFlipped && card.subnote
            ? `<div class="text-xs px-3 py-1.5 rounded-lg" style="background: var(--bg-secondary);">💬 메모: ${escapeHtml(card.subnote)}</div>`
            : ''
        }
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div class="flex gap-1.5">
          <button type="button" onclick="stepFlashcard(-1)" class="px-3 py-2 rounded-xl border text-xs font-bold" style="border-color: var(--border-color);">← 이전</button>
          <button type="button" onclick="stepFlashcard(1)" class="px-3 py-2 rounded-xl border text-xs font-bold" style="border-color: var(--border-color);">다음 →</button>
        </div>
        <div class="flex gap-2">
          <button type="button" onclick="flipCurrentFlashcard()" class="px-3.5 py-2 rounded-xl border text-xs font-bold" style="border-color: var(--border-color);">
            🔄 카드 뒤집기
          </button>
          <button type="button" onclick="markFlashcardMastered()" class="px-4 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700">
            ✅ 외웠어요! (+15 XP)
          </button>
        </div>
      </div>
    </div>
  `;
}

function flipCurrentFlashcard() {
  state.flashcardFlipped = !state.flashcardFlipped;
  renderFlashcardBody();
}

function stepFlashcard(delta) {
  if (state.flashcards.length === 0) return;
  state.flashcardIdx = (state.flashcardIdx + delta + state.flashcards.length) % state.flashcards.length;
  state.flashcardFlipped = false;
  renderFlashcardBody();
}

async function markFlashcardMastered() {
  const card = state.flashcards[state.flashcardIdx];
  if (!card) return;
  showXpToast('🎉 암기 완료! +15 XP');
  if (card.type === 'hl') {
    const res = await apiFetch(`/api/highlights/${card.id}`, {
      method: 'PUT',
      body: JSON.stringify({ mastered: true, increment_review: true }),
    });
    if (res.study_stats) updateStudyGamificationUI(res.study_stats);
  } else {
    const res = await apiFetch('/api/study/log', {
      method: 'POST',
      body: JSON.stringify({ add_quiz: 1, add_xp: 15 }),
    });
    if (res.study_stats) updateStudyGamificationUI(res.study_stats);
  }
  stepFlashcard(1);
}

/* =========================================================
   🍅 Pomodoro Focus Timer
   ========================================================= */
function togglePomodoroPopover() {
  document.getElementById('pomodoro-popover').classList.toggle('hidden');
}

function formatMMSS(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function updatePomodoroUI() {
  const formatted = formatMMSS(state.pomoSecondsLeft);
  document.getElementById('pomodoro-time-label').textContent = formatted;
  document.getElementById('pomo-big-display').textContent = formatted;
  document.getElementById('pomo-mode-badge').textContent = state.pomoModeLabel;
  const startBtn = document.getElementById('btn-pomo-start');
  startBtn.textContent = state.pomoRunning ? '⏸️ 일시정지' : '▶️ 집중 시작';
}

function startOrPausePomodoro() {
  if (state.pomoRunning) {
    clearInterval(state.pomoTimerId);
    state.pomoRunning = false;
    updatePomodoroUI();
    return;
  }
  state.pomoRunning = true;
  updatePomodoroUI();
  state.pomoTimerId = setInterval(async () => {
    if (state.pomoSecondsLeft > 0) {
      state.pomoSecondsLeft -= 1;
      updatePomodoroUI();
    } else {
      clearInterval(state.pomoTimerId);
      state.pomoRunning = false;
      showXpToast('🍅 뽀모도로 집중 완료! +100 XP 획득!');
      const res = await apiFetch('/api/study/log', {
        method: 'POST',
        body: JSON.stringify({
          add_seconds: state.pomoTotalSeconds,
          add_pomodoro: 1,
          add_xp: 100,
        }),
      });
      if (res.study_stats) updateStudyGamificationUI(res.study_stats);
      state.pomoSecondsLeft = state.pomoTotalSeconds;
      updatePomodoroUI();
    }
  }, 1000);
}

function resetPomodoro() {
  clearInterval(state.pomoTimerId);
  state.pomoRunning = false;
  state.pomoSecondsLeft = state.pomoTotalSeconds;
  updatePomodoroUI();
}

function setPomodoroPreset(minutes, label) {
  clearInterval(state.pomoTimerId);
  state.pomoRunning = false;
  state.pomoTotalSeconds = minutes * 60;
  state.pomoSecondsLeft = minutes * 60;
  state.pomoModeLabel = label;
  updatePomodoroUI();
}

/* =========================================================
   📂 Quick Folder & File Switcher Modal (Ctrl+K)
   ========================================================= */
function openQuickSwitcher() {
  const modal = document.getElementById('quick-switcher-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  const inp = document.getElementById('quick-switcher-input');
  inp.value = '';
  renderQuickSwitcherList('');
  setTimeout(() => inp.focus(), 30);
}

function closeQuickSwitcher() {
  const modal = document.getElementById('quick-switcher-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function renderQuickSwitcherList(query) {
  if (!state.library) return;
  const q = String(query || '').trim().toLowerCase();
  const container = document.getElementById('quick-switcher-results');

  const allDirs = Object.values(state.library.directories || {});
  const allDocs = state.library.documents || [];

  const matchedDirs = allDirs
    .filter((d) => !q || d.path.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
    .slice(0, 15);

  const matchedDocs = allDocs
    .filter(
      (d) =>
        !q ||
        d.title.toLowerCase().includes(q) ||
        d.path.toLowerCase().includes(q) ||
        (d.subtitle || '').toLowerCase().includes(q)
    )
    .slice(0, 25);

  let html = '';
  if (matchedDirs.length > 0) {
    html += `<div class="text-[11px] font-bold opacity-60 px-2 pt-1">📁 폴더 (${matchedDirs.length}개)</div>`;
    html += matchedDirs
      .map(
        (dir) => `
        <div onclick="closeQuickSwitcher(); openFolderExplorer('${escapeJsAttr(dir.path)}')"
             class="px-3 py-2 rounded-xl border flex items-center justify-between cursor-pointer hover:opacity-85 transition text-xs"
             style="background: var(--bg-primary); border-color: var(--border-color);">
          <div class="flex items-center gap-2 truncate">
            <span>📂</span>
            <span class="font-bold">${escapeHtml(dir.name)}</span>
            <span class="opacity-55 text-[11px] truncate">(${escapeHtml(dir.path)})</span>
          </div>
          <span class="text-[11px] font-semibold flex-shrink-0" style="color: var(--accent-color);">
            하위폴더 ${dir.subfolder_count} · 파일 ${dir.total_doc_count} →
          </span>
        </div>
      `
      )
      .join('');
  }

  if (matchedDocs.length > 0) {
    html += `<div class="text-[11px] font-bold opacity-60 px-2 pt-2">📄 파일 (${matchedDocs.length}개)</div>`;
    html += matchedDocs
      .map(
        (doc) => `
        <div onmouseenter="prefetchDoc('${escapeJsAttr(doc.path)}')"
             onclick="closeQuickSwitcher(); openDocument('${escapeJsAttr(doc.path)}')"
             class="px-3 py-2 rounded-xl border flex items-center justify-between cursor-pointer hover:opacity-85 transition text-xs"
             style="background: var(--bg-primary); border-color: var(--border-color);">
          <div class="min-w-0">
            <div class="font-bold truncate">📄 ${escapeHtml(doc.title)}</div>
            <div class="text-[10px] opacity-60 truncate">📂 ${escapeHtml(doc.folder || doc.top_folder)}</div>
          </div>
          <span class="text-[11px] font-semibold flex-shrink-0" style="color: var(--accent-color);">열기 →</span>
        </div>
      `
      )
      .join('');
  }

  if (!html) {
    html = `<div class="p-6 text-center text-xs opacity-60">일치하는 폴더나 파일이 없습니다.</div>`;
  }
  container.innerHTML = html;
}

/* =========================================================
   ◫ Split Reference Comparison Pane
   ========================================================= */
function openSplitReferenceChooser() {
  if (!state.library) return;
  const pane = document.getElementById('split-reference-pane');
  pane.classList.remove('hidden');

  const docs = state.library.documents || [];
  const sel = document.getElementById('split-doc-select');
  sel.innerHTML =
    `<option value="">-- 참고할 문서를 선택하세요 --</option>` +
    docs
      .map(
        (d) => `
        <option value="${escapeHtml(d.path)}">[${escapeHtml(d.folder || d.top_folder)}] ${escapeHtml(d.title)}</option>
      `
      )
      .join('');
}

async function openDocInSplitPane(docPath) {
  openSplitReferenceChooser();
  document.getElementById('split-doc-select').value = docPath;
  await loadSplitReferenceDoc(docPath);
}

async function loadSplitReferenceDoc(docPath) {
  if (!docPath) return;
  const body = document.getElementById('split-reference-body');
  let doc = state.docCache.get(docPath);
  if (!doc) {
    body.innerHTML = `<p class="text-xs opacity-60">문서를 불러오는 중...</p>`;
    doc = await apiFetch(`/api/doc?path=${encodeURIComponent(docPath)}`);
    if (doc && doc.path) {
      state.docCache.set(doc.path, doc);
    }
  }
  if (doc.doc_type === 'pdf') {
    body.innerHTML = `<iframe src="${escapeHtml(doc.asset_url)}" class="w-full h-full min-h-[70vh] border-0"></iframe>`;
    return;
  }
  prewarmDocImages(doc.content);
  body.innerHTML = `
    <div class="mb-4 pb-3 border-b" style="border-color: var(--border-color);">
      <div class="text-[11px] font-bold" style="color: var(--accent-color);">📂 ${escapeHtml(doc.folder || doc.top_folder)}</div>
      <h2 class="text-lg font-bold mt-0.5">${escapeHtml(doc.title)}</h2>
    </div>
    <div>${renderObsidianMarkdownToHtml(doc.content || '')}</div>
  `;
  enhanceArticleImages(body);
}

function closeSplitReferencePane() {
  document.getElementById('split-reference-pane').classList.add('hidden');
}

/* =========================================================
   Right Sidebar: 3-Tab Study Panel (TOC | Study Scratchpad | Highlights)
   ========================================================= */
function switchRightTab(tab) {
  state.rightTab = tab;
  ['toc', 'note', 'hl'].forEach((t) => {
    const btn = document.getElementById(`rtab-btn-${t}`);
    const panel = document.getElementById(`rtab-panel-${t}`);
    if (t === tab) {
      btn.style.borderColor = 'var(--accent-color)';
      btn.style.color = 'var(--accent-color)';
      btn.classList.remove('opacity-70');
      panel.classList.remove('hidden');
    } else {
      btn.style.borderColor = 'transparent';
      btn.style.color = 'var(--text-primary)';
      btn.classList.add('opacity-70');
      panel.classList.add('hidden');
    }
  });
}

function renderRightSidebar(doc) {
  const tocList = document.getElementById('right-toc-list');
  const headings = doc.headings || [];
  if (headings.length === 0) {
    tocList.innerHTML = `<p class="text-xs opacity-60">이 문서에는 소제목 목차가 없습니다.</p>`;
  } else {
    tocList.innerHTML = headings
      .map((h) => {
        const indent = (h.level - 1) * 10;
        return `
          <div id="toc-item-${escapeHtml(h.id)}"
               onclick="scrollToHeading('${escapeJsAttr(h.id)}')"
               style="padding-left: ${indent + 8}px;"
               class="toc-entry py-1.5 pr-2 rounded-lg cursor-pointer hover:opacity-100 opacity-75 truncate transition">
            ${escapeHtml(h.text)}
          </div>
        `;
      })
      .join('');
  }

  renderInDocHighlightsAndBookmarks(doc.highlights || [], doc.bookmarks || []);
}

function renderInDocHighlightsAndBookmarks(hls, bms) {
  const hlList = document.getElementById('right-doc-highlights-list');
  if (!hls || hls.length === 0) {
    hlList.innerHTML = `<p class="text-xs opacity-60">본문을 드래그해 형광펜을 칠해보세요.</p>`;
  } else {
    hlList.innerHTML = hls
      .map(
        (h) => `
        <div class="p-2.5 rounded-xl border text-xs space-y-1 cursor-pointer"
             style="background: var(--bg-surface); border-color: var(--border-color);"
             onclick="scrollToPercentage(${h.scroll_percent || 0})">
          <div class="flex items-center justify-between">
            <span class="font-bold text-[11px]" style="color: var(--accent-color);">📍 ${Math.round(h.scroll_percent || 0)}% 위치</span>
            <button type="button" onclick="event.stopPropagation(); deleteHighlightById(${h.id})" class="opacity-50 hover:opacity-100">✕</button>
          </div>
          <div class="p-1.5 rounded font-medium" style="background: var(--hl-bg);">"${escapeHtml(h.selected_text)}"</div>
          ${h.note ? `<div class="text-[11px] opacity-85">💬 ${escapeHtml(h.note)}</div>` : ''}
        </div>
      `
      )
      .join('');
  }

  const bmList = document.getElementById('right-doc-bookmarks-list');
  if (!bms || bms.length === 0) {
    bmList.innerHTML = `<p class="text-xs opacity-60">이 문서에 꽂은 책갈피가 없습니다.</p>`;
  } else {
    bmList.innerHTML = bms
      .map(
        (b) => `
        <div class="p-2 rounded-lg border text-xs cursor-pointer hover:opacity-90 flex items-start justify-between gap-1"
             style="background: var(--bg-surface); border-color: var(--border-color);"
             onclick="scrollToPercentage(${b.scroll_percent})">
          <div class="min-w-0">
            <div class="font-bold" style="color: var(--accent-color);">🔖 ${Math.round(b.scroll_percent)}% ${escapeHtml(b.heading_text || '')}</div>
            ${b.memo ? `<div class="text-[11px] opacity-80 truncate">💬 ${escapeHtml(b.memo)}</div>` : ''}
          </div>
          <button type="button" onclick="event.stopPropagation(); deleteBookmarkById(${b.id})" class="opacity-50 hover:opacity-100 text-[11px]">✕</button>
        </div>
      `
      )
      .join('');
  }
}

function scheduleStudyNoteSave() {
  if (!state.currentDoc) return;
  document.getElementById('study-note-status').textContent = '작성 중...';
  clearTimeout(state.studyNoteTimer);
  state.studyNoteTimer = setTimeout(async () => {
    const content = document.getElementById('study-note-textarea').value;
    const res = await apiFetch('/api/study-note', {
      method: 'POST',
      body: JSON.stringify({
        doc_path: state.currentDoc.path,
        title: state.currentDoc.title,
        folder: state.currentDoc.folder || state.currentDoc.top_folder,
        content,
      }),
    });
    if (res.study_note) {
      document.getElementById('study-note-status').textContent = `✓ 자동 저장됨 (${res.study_note.updated_at.slice(11)})`;
      if (state.currentDoc) state.currentDoc.study_note = res.study_note;
      if (state.library) {
        const rest = (state.library.study_notes || []).filter((n) => n.doc_path !== res.study_note.doc_path);
        state.library.study_notes = [res.study_note, ...rest];
      }
    }
    if (res.study_stats) updateStudyGamificationUI(res.study_stats);
  }, 600);
}

function copyStudyNote() {
  const val = document.getElementById('study-note-textarea').value;
  if (!val) return;
  navigator.clipboard.writeText(val);
  showXpToast('📋 요약 노트가 클립보드에 복사되었습니다!');
}

function renderPrevNextNav(doc) {
  const nav = document.getElementById('doc-prev-next-nav');
  const prevHtml = doc.prev_doc
    ? `
      <div onmouseenter="prefetchDoc('${escapeJsAttr(doc.prev_doc.path)}')"
           onclick="openDocument('${escapeJsAttr(doc.prev_doc.path)}')"
           class="p-4 rounded-2xl border cursor-pointer hover:shadow-sm transition text-left"
           style="background: var(--bg-surface); border-color: var(--border-color);">
        <div class="text-[11px] opacity-60 mb-1">← 이전 파일 (${escapeHtml(doc.prev_doc.folder)})</div>
        <div class="text-sm font-bold truncate">📄 ${escapeHtml(doc.prev_doc.title)}</div>
      </div>
    `
    : `<div></div>`;

  const nextHtml = doc.next_doc
    ? `
      <div onmouseenter="prefetchDoc('${escapeJsAttr(doc.next_doc.path)}')"
           onclick="openDocument('${escapeJsAttr(doc.next_doc.path)}')"
           class="p-4 rounded-2xl border cursor-pointer hover:shadow-sm transition text-right"
           style="background: var(--bg-surface); border-color: var(--border-color);">
        <div class="text-[11px] opacity-60 mb-1">다음 파일 (${escapeHtml(doc.next_doc.folder)}) →</div>
        <div class="text-sm font-bold truncate">📄 ${escapeHtml(doc.next_doc.title)}</div>
      </div>
    `
    : `<div></div>`;

  nav.innerHTML = prevHtml + nextHtml;
}

/* =========================================================
   Scroll Tracking, Auto-Save & Resume Position
   ========================================================= */
function setupScrollListener() {
  const viewport = document.getElementById('reader-viewport');
  viewport.addEventListener(
    'scroll',
    () => {
      if (state.currentView !== 'doc' || !state.currentDoc) return;
      if (state.scrollRafPending) return;
      state.scrollRafPending = true;

      requestAnimationFrame(() => {
        state.scrollRafPending = false;
        if (state.currentView !== 'doc' || !state.currentDoc) return;

        const scrollTop = viewport.scrollTop;
        const maxScroll = Math.max(1, viewport.scrollHeight - viewport.clientHeight);
        const pct = Math.max(0, Math.min(100, (scrollTop / maxScroll) * 100));

        state.currentScrollTop = scrollTop;
        state.currentScrollPercent = pct;
        updateScrollIndicators(pct);
        updateActiveHeadingOnScroll();

        if (state.suppressScrollSave) return;

        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(() => {
          saveCurrentProgress();
        }, 900);
      });
    },
    { passive: true }
  );
}

function updateScrollIndicators(pct) {
  const rounded = Math.round(pct);
  document.getElementById('top-progress-bar').style.width = `${pct}%`;
  const pill = document.getElementById('header-progress-pill');
  if (pill) pill.textContent = `${rounded}%`;
}

function updateActiveHeadingOnScroll() {
  const headings = state.cachedHeadingEls || [];
  if (headings.length === 0) return;

  let active = headings[0];
  for (const h of headings) {
    const rect = h.getBoundingClientRect();
    if (rect.top <= 140) {
      active = h;
    } else {
      break;
    }
  }

  if (active && active.id !== state.currentHeadingId) {
    state.currentHeadingId = active.id;
    state.currentHeadingText = active.childNodes[0] ? active.childNodes[0].textContent.trim() : active.textContent.trim();

    document.querySelectorAll('.toc-entry').forEach((el) => {
      el.style.background = 'transparent';
      el.style.color = 'var(--text-primary)';
      el.style.fontWeight = '400';
    });
    const activeToc = document.getElementById(`toc-item-${active.id}`);
    if (activeToc) {
      activeToc.style.background = 'var(--accent-soft)';
      activeToc.style.color = 'var(--accent-color)';
      activeToc.style.fontWeight = '700';
    }
  }
}

async function saveCurrentProgress() {
  if (!state.currentDoc) return;
  const now = Date.now();
  const elapsedSec = Math.min(120, Math.round((now - state.lastReadTick) / 1000));
  state.lastReadTick = now;

  try {
    const res = await apiFetch('/api/progress', {
      method: 'POST',
      body: JSON.stringify({
        doc_path: state.currentDoc.path,
        title: state.currentDoc.title,
        folder: state.currentDoc.folder || state.currentDoc.top_folder,
        scroll_percent: state.currentScrollPercent,
        scroll_top: state.currentScrollTop,
        heading_id: state.currentHeadingId,
        heading_text: state.currentHeadingText,
        add_seconds: elapsedSec,
      }),
    });
    if (res.progress && state.currentDoc) {
      state.currentDoc.progress = res.progress;
      updateCompleteButtonUI(Boolean(res.progress.is_completed));
      syncLocalDocProgress(state.currentDoc.path, res.progress);
    }
    if (res.study_stats) {
      updateStudyGamificationUI(res.study_stats);
    }
  } catch (e) {
    console.warn('Progress save skipped:', e);
  }
}

function flushPendingProgress() {
  if (state.saveTimer) {
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    saveCurrentProgress();
  }
}

function scrollToPercentage(pct) {
  const viewport = document.getElementById('reader-viewport');
  const maxScroll = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.scrollTop = (maxScroll * pct) / 100;
  updateScrollIndicators(pct);
}

function scrollToHeading(headingId) {
  if (window.innerWidth <= 1024) {
    document.getElementById('sidebar-right').classList.add('collapsed');
    syncMobileBackdrop();
  }
  const target = document.getElementById(headingId);
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function showResumeToast(pct, headingText, alreadyMoved) {
  const toast = document.getElementById('resume-toast');
  const textEl = document.getElementById('resume-toast-text');
  const btn = document.getElementById('btn-resume-jump');

  const rounded = Math.round(pct);
  const sectionLabel = headingText ? ` (${headingText.slice(0, 22)})` : '';

  if (alreadyMoved) {
    textEl.textContent = `📍 마지막 읽던 위치 ${rounded}%${sectionLabel}로 이동했습니다.`;
    btn.textContent = '맨 위로';
    btn.onclick = () => {
      scrollToPercentage(0);
      hideResumeToast();
    };
  } else {
    textEl.textContent = `📍 이전에 읽던 위치(${rounded}%${sectionLabel})가 있습니다.`;
    btn.textContent = '이어 읽기';
    btn.onclick = () => {
      scrollToPercentage(pct);
      hideResumeToast();
    };
  }

  toast.classList.remove('hidden');
  setTimeout(() => {
    hideResumeToast();
  }, 6000);
}

function hideResumeToast() {
  document.getElementById('resume-toast').classList.add('hidden');
}

async function toggleCurrentDocCompleted() {
  if (!state.currentDoc) return;
  const res = await apiFetch('/api/progress/toggle-complete', {
    method: 'POST',
    body: JSON.stringify({
      doc_path: state.currentDoc.path,
      title: state.currentDoc.title,
      folder: state.currentDoc.folder || state.currentDoc.top_folder,
    }),
  });
  if (res.progress) {
    state.currentDoc.progress = res.progress;
    const done = Boolean(res.progress.is_completed);
    updateCompleteButtonUI(done);
    if (done) showXpToast('🎉 문서 완독 달성! +50 XP');
    if (res.study_stats) updateStudyGamificationUI(res.study_stats);
    syncLocalDocProgress(state.currentDoc.path, res.progress);
  }
}

function updateCompleteButtonUI(isCompleted) {
  const topBtn = document.getElementById('btn-doc-complete');
  const botBtn = document.getElementById('btn-bottom-complete');
  if (isCompleted) {
    topBtn.textContent = '✓ 완독 완료';
    topBtn.style.background = 'rgba(16, 185, 129, 0.15)';
    topBtn.style.color = '#059669';
    topBtn.style.borderColor = '#10b981';

    botBtn.textContent = '✓ 완독 완료됨 (클릭 시 해제)';
    botBtn.style.background = 'rgba(16, 185, 129, 0.15)';
    botBtn.style.color = '#059669';
    botBtn.style.borderColor = '#10b981';
  } else {
    topBtn.textContent = '○ 완독 표시';
    topBtn.style.background = 'var(--bg-primary)';
    topBtn.style.color = 'var(--text-primary)';
    topBtn.style.borderColor = 'var(--border-color)';

    botBtn.textContent = '✓ 이 문서 완독 체크하기 (+50 XP)';
    botBtn.style.background = 'transparent';
    botBtn.style.color = 'var(--accent-color)';
    botBtn.style.borderColor = 'var(--accent-color)';
  }
}

/* =========================================================
   Bookmarks & Personal Memos
   ========================================================= */
function setupBookmarkColorPicker() {
  document.querySelectorAll('.bm-color-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedBmColor = btn.dataset.color || 'amber';
      document.querySelectorAll('.bm-color-btn').forEach((b) => {
        b.classList.remove('border-2', 'border-amber-500');
        b.classList.add('border-transparent');
      });
      btn.classList.remove('border-transparent');
      btn.classList.add('border-2', 'border-amber-500');
    });
  });
}

function openBookmarkModal(customTarget = null) {
  if (!state.currentDoc) return;
  const headingId = (customTarget && customTarget.headingId) || state.currentHeadingId;
  const headingText = (customTarget && customTarget.headingText) || state.currentHeadingText;
  const snippet = (customTarget && customTarget.snippet) || '';
  const isHighlightCard = Boolean(customTarget && customTarget.isHighlightCard);
  const pct = Math.round(state.currentScrollPercent || 0);

  state.pendingBmTarget = {
    headingId,
    headingText,
    snippet,
    isHighlightCard,
    hlColor: (customTarget && customTarget.hlColor) || 'yellow',
    scrollPercent: state.currentScrollPercent,
  };

  document.getElementById('bm-modal-header-title').textContent = isHighlightCard
    ? '🃏 선택한 문장 암기카드 & 학습 메모 등록'
    : '🔖 현재 위치 책갈피 & 학습 메모';

  document.getElementById('bm-modal-location').textContent =
    `📄 ${state.currentDoc.title} · ${pct}% 위치 ${headingText ? `(${headingText})` : ''}`;

  const snippetBox = document.getElementById('bm-selected-snippet-box');
  if (snippet) {
    snippetBox.textContent = `"${snippet}"`;
    snippetBox.classList.remove('hidden');
  } else {
    snippetBox.classList.add('hidden');
  }

  document.getElementById('bm-memo-input').value = '';
  const modal = document.getElementById('bookmark-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('bm-memo-input').focus();
}

function closeBookmarkModal() {
  const modal = document.getElementById('bookmark-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function submitBookmarkModal() {
  if (!state.currentDoc) return;
  const memo = document.getElementById('bm-memo-input').value.trim();
  const target = state.pendingBmTarget || {};

  if (target.isHighlightCard && target.snippet) {
    const res = await apiFetch('/api/highlights', {
      method: 'POST',
      body: JSON.stringify({
        doc_path: state.currentDoc.path,
        selected_text: target.snippet,
        title: state.currentDoc.title,
        folder: state.currentDoc.folder || state.currentDoc.top_folder,
        note: memo,
        color: target.hlColor || 'yellow',
        heading_id: target.headingId || '',
        heading_text: target.headingText || '',
        scroll_percent: target.scrollPercent ?? state.currentScrollPercent,
        is_flashcard: true,
      }),
    });
    closeBookmarkModal();
    if (res.highlight) {
      state.currentDoc.highlights = [res.highlight, ...(state.currentDoc.highlights || [])];
      if (state.library) {
        state.library.highlights = [res.highlight, ...(state.library.highlights || [])];
        state.library.stats.total_highlights = state.library.highlights.length;
        updateHeaderAndStats();
        if (state.sidebarTab === 'bookmarks') renderSidebar();
      }
      applySavedHighlightsToDOM([res.highlight]);
      renderRightSidebar(state.currentDoc);
      showXpToast('🃏 암기카드 등록 완료! +20 XP');
      if (res.study_stats) updateStudyGamificationUI(res.study_stats);
    }
    return;
  }

  const res = await apiFetch('/api/bookmarks', {
    method: 'POST',
    body: JSON.stringify({
      doc_path: state.currentDoc.path,
      title: state.currentDoc.title,
      folder: state.currentDoc.folder || state.currentDoc.top_folder,
      scroll_percent: target.scrollPercent ?? state.currentScrollPercent,
      heading_id: target.headingId || '',
      heading_text: target.headingText || '',
      snippet: target.snippet || '',
      memo,
      color: state.selectedBmColor,
    }),
  });

  closeBookmarkModal();
  showXpToast('🔖 책갈피 저장! +15 XP');
  if (res.study_stats) updateStudyGamificationUI(res.study_stats);

  if (res.bookmark) {
    state.currentDoc.bookmarks = [res.bookmark, ...(state.currentDoc.bookmarks || [])];
    if (state.library) {
      state.library.bookmarks = [res.bookmark, ...(state.library.bookmarks || [])];
      state.library.stats.total_bookmarks = state.library.bookmarks.length;
      updateHeaderAndStats();
      if (state.sidebarTab === 'bookmarks') renderSidebar();
    }
    renderRightSidebar(state.currentDoc);
  }
}

async function deleteBookmarkById(id) {
  await apiFetch(`/api/bookmarks/${id}`, { method: 'DELETE' });
  if (state.currentDoc) {
    state.currentDoc.bookmarks = (state.currentDoc.bookmarks || []).filter((b) => b.id !== id);
    renderRightSidebar(state.currentDoc);
  }
  if (state.library) {
    state.library.bookmarks = (state.library.bookmarks || []).filter((b) => b.id !== id);
    state.library.stats.total_bookmarks = state.library.bookmarks.length;
    updateHeaderAndStats();
    if (state.sidebarTab === 'bookmarks') renderSidebar();
    if (state.currentView === 'dashboard') renderDashboard();
  }
}

async function jumpToBookmark(bookmarkId) {
  if (!state.library) return;
  const bm = (state.library.bookmarks || []).find((b) => b.id === bookmarkId);
  if (!bm) return;

  if (state.currentView === 'doc' && state.currentDoc && state.currentDoc.path === bm.doc_path) {
    if (bm.heading_id) {
      scrollToHeading(bm.heading_id);
    } else {
      scrollToPercentage(bm.scroll_percent);
    }
  } else {
    await openDocument(bm.doc_path, {
      targetPercent: bm.scroll_percent,
      targetHeadingId: bm.heading_id || undefined,
    });
  }
}

/* =========================================================
   Paginated Chapter View Mode (Scroll vs Chapter Flip)
   ========================================================= */
function toggleViewMode() {
  const nextMode = state.settings.viewMode === 'scroll' ? 'paginated' : 'scroll';
  applySetting('viewMode', nextMode);
}

function setupChapterPagination() {
  const article = document.getElementById('ebook-article');
  const toolbar = document.getElementById('paginated-toolbar');
  const modeBtn = document.getElementById('btn-view-mode');
  if (!article || !toolbar || !modeBtn) return;

  if (state.settings.viewMode !== 'paginated') {
    toolbar.classList.add('hidden');
    toolbar.classList.remove('flex');
    modeBtn.innerHTML = '📜 스크롤';
    Array.from(article.children).forEach((el) => el.classList.remove('chapter-page-hidden'));
    return;
  }

  modeBtn.innerHTML = '📖 챕터넘김';

  const children = Array.from(article.children);
  const chapters = [];
  let currentGroup = [];

  children.forEach((el) => {
    if (el.tagName === 'H2' && currentGroup.length > 0) {
      chapters.push(currentGroup);
      currentGroup = [el];
    } else {
      currentGroup.push(el);
    }
  });
  if (currentGroup.length > 0) {
    chapters.push(currentGroup);
  }

  state.chapterElements = chapters;
  state.currentChapterIdx = 0;

  if (chapters.length > 1) {
    toolbar.classList.remove('hidden');
    toolbar.classList.add('flex');
    renderCurrentChapterPage();
  } else {
    toolbar.classList.add('hidden');
    toolbar.classList.remove('flex');
  }
}

function renderCurrentChapterPage() {
  const chapters = state.chapterElements || [];
  if (chapters.length === 0) return;

  chapters.forEach((group, idx) => {
    const hide = idx !== state.currentChapterIdx;
    group.forEach((el) => {
      if (hide) el.classList.add('chapter-page-hidden');
      else el.classList.remove('chapter-page-hidden');
    });
  });

  document.getElementById('paginated-status').textContent =
    `챕터 ${state.currentChapterIdx + 1} / ${chapters.length}`;
  document.getElementById('reader-viewport').scrollTop = 0;

  const pct = ((state.currentChapterIdx + 1) / chapters.length) * 100;
  state.currentScrollPercent = pct;
  updateScrollIndicators(pct);
  saveCurrentProgress();
}

function stepChapterPage(delta) {
  const chapters = state.chapterElements || [];
  if (chapters.length <= 1) return;
  const next = state.currentChapterIdx + delta;
  if (next >= 0 && next < chapters.length) {
    state.currentChapterIdx = next;
    renderCurrentChapterPage();
  }
}

/* =========================================================
   TTS Audiobook Reader
   ========================================================= */
function toggleTTS() {
  if (state.ttsActive) {
    stopTTS();
  } else {
    startTTS();
  }
}

function startTTS() {
  if (!('speechSynthesis' in window) || !state.currentDoc) {
    alert('이 브라우저는 음성 합성(TTS)을 지원하지 않습니다.');
    return;
  }
  window.speechSynthesis.cancel();

  const article = document.getElementById('ebook-article');
  const blocks = Array.from(article.querySelectorAll('h1, h2, h3, p, li')).filter(
    (el) => el.textContent.trim().length > 2
  );
  if (blocks.length === 0) return;

  state.ttsQueue = blocks;
  state.ttsIndex = 0;
  state.ttsActive = true;
  document.getElementById('btn-tts').innerHTML = '⏹️ 낭독중지';
  speakNextBlock();
}

function speakNextBlock() {
  if (!state.ttsActive || state.ttsIndex >= state.ttsQueue.length) {
    stopTTS();
    return;
  }
  document.querySelectorAll('.tts-speaking').forEach((el) => el.classList.remove('tts-speaking'));
  const el = state.ttsQueue[state.ttsIndex];
  el.classList.add('tts-speaking');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const cleanText = el.textContent.replace('🔖 책갈피', '').replace('▾ 접기', '').trim();
  const utter = new SpeechSynthesisUtterance(cleanText);
  utter.lang = 'ko-KR';
  utter.rate = 1.05;
  utter.onend = () => {
    if (!state.ttsActive) return;
    state.ttsIndex += 1;
    speakNextBlock();
  };
  utter.onerror = () => {
    stopTTS();
  };
  window.speechSynthesis.speak(utter);
}

function stopTTS() {
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  state.ttsActive = false;
  document.querySelectorAll('.tts-speaking').forEach((el) => el.classList.remove('tts-speaking'));
  const btn = document.getElementById('btn-tts');
  if (btn) btn.innerHTML = '🎧 낭독';
}

/* =========================================================
   Typography, Eye-Care Theme & Sidebar Controls
   ========================================================= */
function toggleSettingsPopover() {
  const pop = document.getElementById('settings-popover');
  pop.classList.toggle('hidden');
  if (!pop.classList.contains('hidden')) renderViewSettings();
}

function applySetting(key, val) {
  state.settings[key] = val;
  applySettingsToDOM();
  saveSettingsSoon();
}

function stepSetting(key, delta) {
  if (key === 'fontSize') {
    const next = Math.max(14, Math.min(28, Number(state.settings.fontSize || 18) + delta));
    applySetting('fontSize', next);
  } else if (key === 'lineHeight') {
    const next = Math.max(1.4, Math.min(2.4, Number((Number(state.settings.lineHeight || 1.9) + delta).toFixed(2))));
    applySetting('lineHeight', next);
  }
}

/* =========================================================
   보기 설정 창 (배율·테마·글꼴·크기·간격·폭·필터) — 현재 선택 표시 + 기본값 되돌리기
   - 테마·글꼴·크기 등은 서버에 저장(모든 기기 공통), 본문 배율·배율 버튼 표시는 이 기기에만 저장
   ========================================================= */
const VIEW_DEFAULTS = { theme: 'warm_paper', fontFamily: 'ridi', fontSize: 18, lineHeight: 1.9, paraSpacing: 1.3, maxWidth: '820px', eyeCareFilter: 0, autoRestoreScroll: true };
const VIEW_THEMES = [
  { id: 'warm_paper', label: '🌾 웜 페이퍼', bg: '#f4efe6', fg: '#2b2620', bd: '#d5c7b2' },
  { id: 'paper_white', label: '📄 화이트', bg: '#ffffff', fg: '#1f2328', bd: '#e5e7eb' },
  { id: 'sepia', label: '📜 세피아', bg: '#eee4d3', fg: '#2f251b', bd: '#cbb99c' },
  { id: 'soft_light', label: '☁️ 소프트 라이트', bg: '#f6f5f2', fg: '#22252a', bd: '#dcdad2' },
  { id: 'forest', label: '🌿 칠판 그린', bg: '#eaf1ec', fg: '#1e2d24', bd: '#bcd2c3' },
  { id: 'blossom', label: '🌸 블라썸', bg: '#f8efef', fg: '#2e2426', bd: '#e8d4d4' },
  { id: 'eink', label: '🖋 전자잉크', bg: '#ffffff', fg: '#000000', bd: '#000000' },
  { id: 'dark', label: '🌙 웜 다크', bg: '#18191c', fg: '#dcd8d0', bd: '#343842' },
  { id: 'deep_forest', label: '🌲 딥 포레스트', bg: '#131b16', fg: '#d4e2da', bd: '#2d4035' },
  { id: 'slate_night', label: '🌌 슬레이트 나이트', bg: '#1b2230', fg: '#d8dee9', bd: '#364156' },
  { id: 'oled_black', label: '⬛ 완전 블랙', bg: '#000000', fg: '#d6d6d6', bd: '#262626' },
];
const VIEW_FONTS = [
  { id: 'ridi', label: '리디바탕', css: "'RIDIBatang', 'MaruBuri', 'Noto Serif KR', Georgia, serif", kind: '명조' },
  { id: 'maru', label: '마루부리', css: "'MaruBuri', 'RIDIBatang', 'Noto Serif KR', serif", kind: '명조' },
  { id: 'gowun', label: '고운바탕', css: "'Gowun Batang', 'RIDIBatang', serif", kind: '명조' },
  { id: 'nanum_myeongjo', label: '나눔명조', css: "'Nanum Myeongjo', 'Noto Serif KR', serif", kind: '명조' },
  { id: 'serif', label: '본명조(Noto Serif)', css: "'Noto Serif KR', 'RIDIBatang', Georgia, serif", kind: '명조' },
  { id: 'hahmlet', label: '함렛', css: "'Hahmlet', 'Noto Serif KR', serif", kind: '명조' },
  { id: 'sans', label: '프리텐다드', css: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif", kind: '고딕' },
  { id: 'noto_sans', label: '본고딕(Noto Sans)', css: "'Noto Sans KR', 'Pretendard', sans-serif", kind: '고딕' },
  { id: 'nanum_gothic', label: '나눔고딕', css: "'Nanum Gothic', 'Pretendard', sans-serif", kind: '고딕' },
  { id: 'ibm_plex', label: 'IBM Plex Sans KR', css: "'IBM Plex Sans KR', 'Pretendard', sans-serif", kind: '고딕' },
  { id: 'gowun_dodum', label: '고운돋움', css: "'Gowun Dodum', 'Pretendard', sans-serif", kind: '고딕' },
  { id: 'mono', label: 'JetBrains Mono', css: "'JetBrains Mono', monospace", kind: '고정폭' },
];
const VIEW_SLIDERS = [
  { key: 'fontSize', label: '글자 크기', min: 12, max: 40, step: 1, unit: 'px' },
  { key: 'lineHeight', label: '줄 간격', min: 1.2, max: 3.0, step: 0.05, unit: '배' },
  { key: 'paraSpacing', label: '문단 간격', min: 0.4, max: 3.0, step: 0.1, unit: 'em' },
  { key: 'maxWidth', label: '본문 폭', min: 480, max: 2400, step: 20, unit: 'px', note: '사진 크기도 본문 폭 안에서 맞춰집니다' },
  { key: 'eyeCareFilter', label: '🌙 블루라이트 차단', min: 0, max: 60, step: 1, unit: '%' },
];
let _settingsSaveTimer = null;
function saveSettingsSoon() {
  clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(() => {
    apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(state.settings) }).catch(() => {});
  }, 400);
}
function viewFontCss(id) { return (VIEW_FONTS.find((f) => f.id === id) || VIEW_FONTS[0]).css; }
function clampNum(v, min, max) { v = Number(v); if (!isFinite(v)) return min; return Math.min(max, Math.max(min, v)); }
function settingValue(key) {
  const s = state.settings;
  if (key === 'maxWidth') return s.maxWidth === '100%' ? 2400 : parseInt(s.maxWidth || '820', 10);
  return Number(s[key] ?? VIEW_DEFAULTS[key]);
}
function setViewSetting(key, raw, rerender = false) {
  const def = VIEW_SLIDERS.find((d) => d.key === key);
  if (def) {
    const v = clampNum(raw, def.min, def.max);
    const rounded = def.step < 1 ? Number((Math.round(v / def.step) * def.step).toFixed(2)) : Math.round(v);
    state.settings[key] = key === 'maxWidth' ? `${rounded}px` : rounded;
  } else {
    state.settings[key] = raw;
  }
  applySettingsToDOM();
  saveSettingsSoon();
  if (rerender) renderViewSettings(); else syncViewSettingsUI();
}
function resetViewSetting(key) {
  if (key === 'zoom') { applyReaderZoom(1); renderViewSettings(); return; }
  setViewSetting(key, key === 'maxWidth' ? 820 : VIEW_DEFAULTS[key], true);
}
function resetAllViewSettings() {
  if (!confirm('보기 설정을 모두 기본값으로 되돌릴까요?\n(배경 테마·글꼴·크기·간격·본문 폭·필터, 그리고 이 기기의 본문 배율)')) return;
  Object.assign(state.settings, VIEW_DEFAULTS);
  applyReaderZoom(1);
  applySettingsToDOM(); saveSettingsSoon(); renderViewSettings();
}
function setZoomButtonVisible(on) {
  try { localStorage.setItem('obsibook_zoom_btn', on ? '1' : '0'); } catch (e) {}
  document.body.classList.toggle('hide-zoom-btn', !on);
}
function zoomButtonVisible() { try { return localStorage.getItem('obsibook_zoom_btn') !== '0'; } catch (e) { return true; } }

function vsRow(def, value) {
  const id = `vs-${def.key}`;
  const full = def.key === 'maxWidth' && state.settings.maxWidth === '100%';
  return `<div class="vs-row">
    <div class="vs-row-top">
      <span class="vs-row-label">${def.label}</span>
      <span class="flex items-center gap-1">
        <input type="number" class="vs-num" id="${id}-num" min="${def.min}" max="${def.max}" step="${def.step}" value="${value}" ${full ? 'disabled' : ''}
          onchange="setViewSetting('${def.key}', this.value)" aria-label="${def.label} 숫자 입력" />
        <span class="vs-unit">${def.unit}</span>
        <button type="button" class="vs-reset" onclick="resetViewSetting('${def.key}')" title="기본값으로">↺</button>
      </span>
    </div>
    <input type="range" class="vs-range" id="${id}-rng" min="${def.min}" max="${def.max}" step="${def.step}" value="${value}" ${full ? 'disabled' : ''}
      oninput="setViewSetting('${def.key}', this.value)" aria-label="${def.label}" />
    ${def.key === 'maxWidth' ? `<label class="vs-check"><span>화면 가득 채우기 <span class="vs-sub">본문 폭 제한 없음</span></span>
      <input type="checkbox" ${full ? 'checked' : ''} onchange="state.settings.maxWidth = this.checked ? '100%' : '${settingValue('maxWidth') >= 2400 ? 1040 : settingValue('maxWidth')}px'; applySettingsToDOM(); saveSettingsSoon(); renderViewSettings();" /></label>` : ''}
    ${def.note ? `<div class="vs-note">${def.note}</div>` : ''}
  </div>`;
}
function renderViewSettings() {
  const box = document.getElementById('view-settings-body');
  if (!box) return;
  const s = state.settings;
  const z = Math.round((state.readerZoom || 1) * 100);
  const devName = { phone: '휴대폰', tablet: '태블릿', desktop: 'PC', large: '큰 모니터' }[readerDeviceClass()] || '이 기기';
  box.innerHTML = `
  <div>
    <div class="vs-head"><span class="vs-title">🔎 본문 배율 <span class="vs-sub">${devName}에만 적용 · 제목·본문·사진만 확대</span></span>
      <button type="button" class="vs-reset" onclick="resetViewSetting('zoom')" title="100%로">↺ 100%</button></div>
    <div class="vs-row-top"><span class="vs-row-label">배율</span>
      <span class="flex items-center gap-1"><input type="number" class="vs-num" id="vs-zoom-num" min="50" max="300" step="5" value="${z}"
        onchange="applyReaderZoom(clampNum(this.value,50,300)/100); syncViewSettingsUI();" aria-label="본문 배율 숫자 입력" /><span class="vs-unit">%</span></span></div>
    <input type="range" class="vs-range" id="vs-zoom-rng" min="50" max="300" step="5" value="${z}" oninput="applyReaderZoom(Number(this.value)/100); syncViewSettingsUI();" aria-label="본문 배율" />
    <label class="vs-check"><span>화면 오른쪽 아래에 배율 버튼(가− 가+) 표시</span>
      <input type="checkbox" ${zoomButtonVisible() ? 'checked' : ''} onchange="setZoomButtonVisible(this.checked)" /></label>
    <div class="vs-note">단축키: Alt(맥은 Option) + = / − / 0</div>
  </div>
  <div class="vs-section">
    <div class="vs-head"><span class="vs-title">🧘 집중 모드 <span class="vs-sub">제목·본문만 남기고 모두 숨김 (F / Esc)</span></span>
      <button type="button" class="vs-reset" style="color:var(--accent-color);border-color:var(--accent-color)" onclick="toggleZenMode(true)" ${state.currentDoc ? '' : 'disabled title="문서를 연 뒤 사용할 수 있습니다"'}>⛶ 지금 시작</button></div>
  </div>
  <div class="vs-section">
    <div class="vs-head"><span class="vs-title">🎨 배경 테마 <span class="vs-sub">지금: ${(VIEW_THEMES.find((t) => t.id === s.theme) || VIEW_THEMES[0]).label}</span></span>
      <button type="button" class="vs-reset" onclick="resetViewSetting('theme')">↺ 기본</button></div>
    <div class="vs-grid grid-cols-2 sm:grid-cols-3">${VIEW_THEMES.map((t) => `<button type="button" class="vs-opt ${s.theme === t.id ? 'is-active' : ''}"
      style="background:${t.bg};color:${t.fg};border-color:${s.theme === t.id ? '' : t.bd}" onclick="setViewSetting('theme','${t.id}',true)" aria-pressed="${s.theme === t.id}">${t.label}</button>`).join('')}</div>
  </div>
  <div class="vs-section">
    <div class="vs-head"><span class="vs-title">🔤 본문 글꼴 <span class="vs-sub">지금: ${(VIEW_FONTS.find((f) => f.id === s.fontFamily) || VIEW_FONTS[0]).label}</span></span>
      <button type="button" class="vs-reset" onclick="resetViewSetting('fontFamily')">↺ 기본</button></div>
    <div class="vs-grid grid-cols-2">${VIEW_FONTS.map((f) => `<button type="button" class="vs-opt ${s.fontFamily === f.id ? 'is-active' : ''}"
      style="font-family:${f.css.replace(/"/g, '&quot;')}" onclick="setViewSetting('fontFamily','${f.id}',true)" aria-pressed="${s.fontFamily === f.id}">${f.label}<br><span class="vs-sub" style="margin:0">${f.kind} · 가나다 Abc 123</span></button>`).join('')}</div>
  </div>
  <div class="vs-section">
    <div class="vs-head"><span class="vs-title">📏 크기·간격·폭</span></div>
    ${VIEW_SLIDERS.map((d) => vsRow(d, settingValue(d.key))).join('')}
  </div>
  <div class="vs-section">
    <label class="vs-check"><span>문서 열 때 이전에 읽던 위치로 자동 이동</span>
      <input type="checkbox" ${s.autoRestoreScroll ? 'checked' : ''} onchange="setViewSetting('autoRestoreScroll', this.checked)" /></label>
  </div>
  <div class="vs-section flex items-center justify-between">
    <span class="vs-note" style="margin:0">기본값: 웜 페이퍼 · 리디바탕 · 18px · 줄 간격 1.9 · 문단 1.3em · 폭 820px · 필터 0% · 배율 100%</span>
    <button type="button" class="vs-reset" style="white-space:nowrap" onclick="resetAllViewSettings()">↺ 전체 기본값으로</button>
  </div>`;
}
function syncViewSettingsUI() {
  // 슬라이더를 움직이는 중에는 창 전체를 다시 그리지 않고 숫자만 맞춤(끊김 방지)
  VIEW_SLIDERS.forEach((d) => {
    const v = settingValue(d.key);
    const n = document.getElementById(`vs-${d.key}-num`), r = document.getElementById(`vs-${d.key}-rng`);
    if (n && document.activeElement !== n) n.value = v;
    if (r && document.activeElement !== r) r.value = v;
  });
  const z = Math.round((state.readerZoom || 1) * 100);
  const zn = document.getElementById('vs-zoom-num'), zr = document.getElementById('vs-zoom-rng');
  if (zn && document.activeElement !== zn) zn.value = z;
  if (zr && document.activeElement !== zr) zr.value = z;
}

/* =========================================================
   본문 배율 (기기 종류별로 따로 기억)
   - 서버에 저장되는 글자 크기(fontSize)는 그대로 두고, 그 위에 이 기기에서만 쓰는 배율을 곱한다
   - 기기 종류는 창 크기가 아니라 화면 크기·터치 여부로 판단 → 창을 줄였다 늘려도 바뀌지 않음
   ========================================================= */
const READER_ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2, 2.25, 2.5];
function readerDeviceClass() {
  const sw = Math.max(window.screen?.width || 0, window.screen?.height || 0);
  const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (coarse) return Math.min(window.screen?.width || 0, window.screen?.height || 0) < 600 ? "phone" : "tablet";
  return sw >= 2200 ? "large" : "desktop";
}
function readerZoomKey() { return "obsibook_reader_zoom_" + readerDeviceClass(); }
function loadReaderZoom() {
  try {
    const v = Number(localStorage.getItem(readerZoomKey()));
    return v >= 0.5 && v <= 3 ? v : 1;
  } catch (e) { return 1; }
}
function applyReaderZoom(z, save = true) {
  state.readerZoom = z;
  document.documentElement.style.setProperty("--reader-zoom", String(z));
  const lbl = document.getElementById("reader-zoom-label");
  if (lbl) lbl.textContent = Math.round(z * 100) + "%";
  const out = document.getElementById("btn-reader-zoom-out"), inn = document.getElementById("btn-reader-zoom-in");
  if (out) out.disabled = z <= READER_ZOOM_STEPS[0];
  if (inn) inn.disabled = z >= READER_ZOOM_STEPS[READER_ZOOM_STEPS.length - 1];
  if (save) { try { localStorage.setItem(readerZoomKey(), String(z)); } catch (e) {} }
  if (save && state.currentDoc && typeof setupChapterPagination === "function") setupChapterPagination();
}
function stepReaderZoom(dir) {
  const cur = state.readerZoom || 1;
  // 다음/이전 단계(슬라이더로 정한 중간값에서도 자연스럽게 이어짐)
  const n = dir > 0 ? (READER_ZOOM_STEPS.find((x) => x > cur + 0.001) ?? cur) : ([...READER_ZOOM_STEPS].reverse().find((x) => x < cur - 0.001) ?? cur);
  if (n !== cur) applyReaderZoom(n);
  syncViewSettingsUI();
}
function resetReaderZoom() { applyReaderZoom(1); }

function applySettingsToDOM() {
  const s = state.settings;
  document.documentElement.setAttribute('data-theme', s.theme || 'warm_paper');

  const fontMap = {
    ridi: "'RIDIBatang', 'MaruBuri', 'Noto Serif KR', Georgia, serif",
    maru: "'MaruBuri', 'RIDIBatang', 'Noto Serif KR', serif",
    gowun: "'Gowun Batang', 'RIDIBatang', serif",
    serif: "'Noto Serif KR', 'RIDIBatang', Georgia, serif",
    sans: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
    mono: "'JetBrains Mono', monospace",
  };
  document.documentElement.style.setProperty('--reader-font', viewFontCss(s.fontFamily) || fontMap.ridi);
  document.documentElement.style.setProperty('--reader-para-spacing', `${Number(s.paraSpacing ?? 1.3)}em`);
  document.documentElement.style.setProperty('--reader-font-size', `${s.fontSize || 18}px`);
  document.documentElement.style.setProperty('--reader-line-height', String(s.lineHeight || 1.9));
  document.documentElement.style.setProperty('--reader-max-width', s.maxWidth || '820px');
  applyReaderZoom(state.readerZoom || loadReaderZoom(), false);
  document.body.classList.toggle('hide-zoom-btn', !zoomButtonVisible());

  const eyeVal = Number(s.eyeCareFilter || 0);
  const overlay = document.getElementById('eyecare-overlay');
  if (overlay) {
    overlay.style.background = `rgba(255, 166, 77, ${(eyeVal / 100).toFixed(2)})`;
  }
  const eyeLbl = document.getElementById('lbl-eyecare-val');
  const eyeRng = document.getElementById('rng-eyecare');
  if (eyeLbl) eyeLbl.textContent = `${eyeVal}%`;
  if (eyeRng) eyeRng.value = String(eyeVal);

  document.getElementById('lbl-font-size').textContent = `${s.fontSize || 18}px`;
  document.getElementById('lbl-line-height').textContent = String(s.lineHeight || 1.9);
  document.getElementById('chk-auto-restore').checked = Boolean(s.autoRestoreScroll);

  if (state.currentDoc) {
    setupChapterPagination();
  }
}

function toggleLeftSidebar() {
  const left = document.getElementById('sidebar-left');
  const right = document.getElementById('sidebar-right');
  left.classList.toggle('collapsed');
  if (window.innerWidth <= 768 && !left.classList.contains('collapsed')) {
    right.classList.add('collapsed');
  }
  syncMobileBackdrop();
}

function toggleRightSidebar() {
  const left = document.getElementById('sidebar-left');
  const right = document.getElementById('sidebar-right');
  right.classList.toggle('collapsed');
  if (window.innerWidth <= 768 && !right.classList.contains('collapsed')) {
    left.classList.add('collapsed');
  }
  syncMobileBackdrop();
}

function syncMobileBackdrop() {
  const backdrop = document.getElementById('mobile-backdrop');
  if (!backdrop) return;
  const leftOpen = !document.getElementById('sidebar-left').classList.contains('collapsed');
  const rightOpen = !document.getElementById('sidebar-right').classList.contains('collapsed');
  const isSmallLeft = window.innerWidth <= 768 && leftOpen;
  const isSmallRight = window.innerWidth <= 1024 && rightOpen;
  if (isSmallLeft || isSmallRight) {
    backdrop.classList.add('active');
  } else {
    backdrop.classList.remove('active');
  }
}

function closeMobileDrawers() {
  if (window.innerWidth <= 768) {
    document.getElementById('sidebar-left').classList.add('collapsed');
  }
  if (window.innerWidth <= 1024) {
    document.getElementById('sidebar-right').classList.add('collapsed');
  }
  syncMobileBackdrop();
}

function setupMobileAndTouchUX() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushPendingProgress();
    }
  });
  window.addEventListener('pagehide', () => {
    flushPendingProgress();
  });

  let touchStartX = 0;
  let touchStartY = 0;
  const viewport = document.getElementById('reader-viewport');
  viewport.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    },
    { passive: true }
  );
  viewport.addEventListener(
    'touchend',
    (e) => {
      if (!state.currentDoc || state.settings.viewMode !== 'paginated') return;
      if (e.changedTouches.length === 1) {
        const dx = e.changedTouches[0].clientX - touchStartX;
        const dy = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.8) {
          if (dx < 0) stepChapterPage(1);
          else stepChapterPage(-1);
        }
      }
    },
    { passive: true }
  );
}

/* 집중 모드: 제목·본문만 남기고 모두 숨김 + (지원하면) 브라우저 전체화면
   - 들어가기: 문서 화면 "⛶ 집중 모드" 버튼 / 보기 설정 / F 키
   - 나오기: 오른쪽 위 ✕ / Esc / F 키 (전체화면을 Esc로 끄면 집중 모드도 같이 끝남) */
function toggleZenMode(force) {
  const on = typeof force === 'boolean' ? force : !document.body.classList.contains('zen-mode');
  if (on && !state.currentDoc) return; // 문서를 볼 때만
  document.body.classList.toggle('zen-mode', on);
  document.getElementById('settings-popover')?.classList.add('hidden');
  const el = document.documentElement;
  const isFs = () => document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (on && !isFs()) {
      const req = el.requestFullscreen || el.webkitRequestFullscreen;
      const r = req && req.call(el); if (r && r.catch) r.catch(() => {});
    } else if (!on && isFs()) {
      const ex = document.exitFullscreen || document.webkitExitFullscreen;
      const r = ex && ex.call(document); if (r && r.catch) r.catch(() => {});
    }
  } catch (e) { /* 전체화면 미지원(예: 아이폰) → 화면 정리만 */ }
  if (state.currentDoc && typeof setupChapterPagination === 'function') setupChapterPagination();
}
['fullscreenchange', 'webkitfullscreenchange'].forEach((ev) => document.addEventListener(ev, () => {
  if (!(document.fullscreenElement || document.webkitFullscreenElement) && document.body.classList.contains('zen-mode')) toggleZenMode(false);
}));

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openQuickSwitcher();
      return;
    }
    if (e.key === 'Escape') {
      if (document.body.classList.contains('zen-mode')) { toggleZenMode(false); return; }
      closeQuickSwitcher();
      closeFlashcardModal();
      closeBookmarkModal();
      closeDomainModal();
      document.getElementById('settings-popover')?.classList.add('hidden');
      document.getElementById('pomodoro-popover')?.classList.add('hidden');
      return;
    }

    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

    // 본문 배율: Alt + = / Alt + - / Alt + 0 (브라우저 확대 Ctrl 과 겹치지 않음)
    // e.code(키 위치)로 판단: Mac 은 Option+= 가 "≠" 등으로 입력되기 때문
    if (e.altKey && !e.ctrlKey && !e.metaKey && ['Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract', 'Digit0', 'Numpad0'].includes(e.code)) {
      e.preventDefault();
      if (e.code.endsWith('0')) resetReaderZoom(); else stepReaderZoom(/Minus|Subtract/.test(e.code) ? -1 : 1);
      return;
    }

    if (e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateBack();
    } else if (e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      navigateForward();
    } else if (e.key === 'f' || e.key === 'F') {
      toggleZenMode();
    } else if ((e.key === 'm' || e.key === 'M') && state.currentDoc) {
      e.preventDefault();
      toggleClozeMode();
    } else if ((e.key === 'b' || e.key === 'B') && state.currentDoc) {
      e.preventDefault();
      openBookmarkModal();
    } else if (e.key === 'ArrowLeft' && state.currentDoc && state.settings.viewMode === 'paginated') {
      stepChapterPage(-1);
    } else if (e.key === 'ArrowRight' && state.currentDoc && state.settings.viewMode === 'paginated') {
      stepChapterPage(1);
    }
  });
}

/* =========================================================
   🌐 Built-in Cloudflare Domain & Remote Access Manager
   ========================================================= */
let tunnelPollTimer = null;

async function openDomainModal() {
  const modal = document.getElementById('domain-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  await refreshTunnelStatus();

  clearInterval(tunnelPollTimer);
  tunnelPollTimer = setInterval(refreshTunnelStatus, 4000);
}

function closeDomainModal() {
  const modal = document.getElementById('domain-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  clearInterval(tunnelPollTimer);
}

async function refreshTunnelStatus() {
  try {
    const st = await apiFetch('/api/tunnel/status');
    const dot = document.getElementById('tunnel-status-dot');
    const title = document.getElementById('tunnel-status-title');
    const stopBtn = document.getElementById('btn-stop-tunnel');
    const urlBox = document.getElementById('tunnel-active-url-box');
    const urlLink = document.getElementById('tunnel-active-url');
    const domainInput = document.getElementById('cf-domain-input');
    const pwdBadge = document.getElementById('pwd-status-badge');

    if (st.custom_domain && document.activeElement !== domainInput) {
      domainInput.value = st.custom_domain;
    }

    if (st.password_enabled) {
      pwdBadge.textContent = '🔒 비밀번호 잠금 켜짐';
      pwdBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700';
    } else {
      pwdBadge.textContent = '🔓 비밀번호 없음 (누구나 열람 가능)';
      pwdBadge.className = 'text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700';
    }

    if (st.running) {
      dot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
      title.textContent = st.status_message || '외부 접속 터널이 정상 가동 중입니다.';
      stopBtn.classList.remove('hidden');

      if (st.public_url) {
        urlBox.classList.remove('hidden');
        urlLink.href = st.public_url;
        urlLink.textContent = st.public_url;
      } else {
        urlBox.classList.add('hidden');
      }
    } else {
      dot.className = 'w-2.5 h-2.5 rounded-full bg-gray-400';
      title.textContent = st.status_message || '외부 접속 터널이 대기 중입니다.';
      stopBtn.classList.add('hidden');
      urlBox.classList.add('hidden');
    }

    const loginBox = document.getElementById('cf-login-url-box');
    const loginLink = document.getElementById('cf-login-url-link');
    if (st.login_url && !st.has_cert) {
      loginBox.classList.remove('hidden');
      loginLink.href = st.login_url;
    } else if (st.has_cert) {
      loginBox.classList.add('hidden');
    }
  } catch (e) {
    console.warn('Tunnel status check failed:', e);
  }
}

async function startQuickTunnel() {
  document.getElementById('tunnel-status-title').textContent = '⚡ 임시 HTTPS 외부 접속 주소를 생성하고 있습니다 (약 3~5초)...';
  await apiFetch('/api/tunnel/quick', { method: 'POST' });
  await refreshTunnelStatus();
}

async function connectWithTunnelToken() {
  const token = document.getElementById('cf-token-input').value.trim();
  const customDomain = document.getElementById('cf-domain-input').value.trim();
  if (!token) {
    alert('Cloudflare Zero Trust에서 복사한 터널 토큰(eyJ...)을 입력해 주세요.');
    return;
  }
  document.getElementById('tunnel-status-title').textContent = '🎫 도메인 터널을 연결하고 있습니다...';
  const res = await apiFetch('/api/tunnel/token', {
    method: 'POST',
    body: JSON.stringify({ token, custom_domain: customDomain }),
  });
  if (!res.ok) {
    alert(res.error || '터널 연결에 실패했습니다.');
  }
  await refreshTunnelStatus();
}

async function startCloudflareLoginFlow() {
  const customDomain = document.getElementById('cf-domain-input').value.trim();
  document.getElementById('tunnel-status-title').textContent = '🔑 Cloudflare 도메인 인증 링크를 준비하고 있습니다...';
  const res = await apiFetch('/api/tunnel/login', {
    method: 'POST',
    body: JSON.stringify({ custom_domain: customDomain }),
  });
  if (!res.ok) {
    alert(res.error || '인증 링크 생성에 실패했습니다.');
  }
  await refreshTunnelStatus();
}

async function handleCertFileUpload(inputEl) {
  const file = inputEl.files && inputEl.files[0];
  if (!file) return;
  const text = await file.text();
  const customDomain = document.getElementById('cf-domain-input').value.trim();
  document.getElementById('tunnel-status-title').textContent = `✅ 인증서 확인 완료! ${customDomain || '도메인'} 자동 개통 중...`;
  const res = await apiFetch('/api/tunnel/cert', {
    method: 'POST',
    body: JSON.stringify({ cert_pem: text, custom_domain: customDomain }),
  });
  if (!res.ok) {
    alert(res.error || '인증서 등록에 실패했습니다.');
  }
  await refreshTunnelStatus();
}

async function stopTunnel() {
  await apiFetch('/api/tunnel/stop', { method: 'POST' });
  await refreshTunnelStatus();
}

function copyActiveTunnelUrl() {
  const url = document.getElementById('tunnel-active-url').textContent.trim();
  if (!url) return;
  navigator.clipboard.writeText(url);
  alert(`접속 주소가 복사되었습니다:\n${url}`);
}

async function saveLibraryPassword() {
  const newPwd = document.getElementById('new-app-password-input').value.trim();
  const res = await apiFetch('/api/auth/set-password', {
    method: 'POST',
    body: JSON.stringify({ new_password: newPwd }),
  });
  if (res.token) {
    localStorage.setItem('obsibook_token', res.token);
  } else {
    localStorage.removeItem('obsibook_token');
  }
  document.getElementById('new-app-password-input').value = '';
  alert(
    newPwd
      ? '🔒 서재 열람 비밀번호가 설정되었습니다. 외부 도메인으로 접속할 때 이 비밀번호로 보호됩니다.'
      : '🔓 서재 비밀번호 잠금이 해제되었습니다.'
  );
  await refreshTunnelStatus();
}
