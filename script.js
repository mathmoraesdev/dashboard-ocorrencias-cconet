/**
 * ============================================================
 * PAINEL DE OCORRÊNCIAS - GCM
 * Dashboard com integração Google Sheets
 * Arquitetura limpa e organizada
 * ============================================================
 */

// ============================================================
// 1. CONFIGURAÇÃO
// ============================================================

const CONFIG = {
  SHEET_URL: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQc9Z1rDFqIOl_mbJZWIGlvfp6afWsQNiHTlAPKnuVhvJDMj1RpRXkU8r2Pt19x7PKvjfjc_4ssreiS/pub?output=csv',
  LOG_PAGE_SIZE: 50,
  RANK_TOP_N: 12,
  HEATMAP_COLORS: [
    [22, 35, 44],
    [29, 74, 72],
    [42, 122, 113],
    [63, 184, 171],
    [232, 168, 74]
  ],
  NATUREZA_COLORS: [
    '#3fb8ab', '#e8a84a', '#6f9bd1', '#d9705f', '#8a7fd6',
    '#6fbf6f', '#d68fc4', '#c9c15a', '#5fb8d6', '#b48a5f'
  ],
  // Lista oficial de bairros de São Leopoldo/RS. Usada para filtrar
  // registros com nomes de bairro divergentes/incorretos vindos da fonte.
  OFFICIAL_BAIRROS: [
    'Arroio da Manteiga', 'Boa Vista', 'Campestre', 'Campina', 'Centro',
    'Cristo Rei', 'Duque de Caxias', 'Fazenda São Borja', 'Feitoria', 'Fião',
    'Jardim América', 'Morro do Espelho', 'Padre Reus', 'Pinheiro', 'Rio Branco',
    'Rio dos Sinos', 'Santa Tereza', 'Santo André', 'Santos Dumont',
    'São João Batista', 'São José', 'São Miguel', 'Scharlau', 'Vicentina'
  ]
};

// ============================================================
// 2. CONSTANTES
// ============================================================

const WEEKDAYS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTHS_PT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MONTHS_FULL_PT = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const SMALLWORDS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o', 'à', 'ao', 'sob', 'com', 'sem']);

// ============================================================
// 3. ESTADO GLOBAL
// ============================================================

const state = {
  // Dados brutos por mês
  monthBuckets: {},
  // Todos os registros achatados
  all: [],
  // Dados após aplicação de filtros
  filtered: [],
  // Filtros ativos
  filters: {
    dateFrom: null,
    dateTo: null,
    tipos: null,        // null = todos, Set = selecionados
    bairros: null,      // null = todos, Set = selecionados
    regional: '',
    natureza: null,
    bairroOficial: false // true = considera apenas bairros da lista oficial de São Leopoldo
  },
  // Controles de visualização
  view: {
    granularity: 'day'
  },
  // Paginação e ordenação do log
  log: {
    sortKey: 'd',
    sortDir: 'desc',
    page: 1,
    pageSize: CONFIG.LOG_PAGE_SIZE,
    search: ''
  },
  // Metadados (caches)
  meta: {
    tipos: [],
    bairros: [],
    regionais: [],
    naturezas: []
  },
  // Histórico de sincronização
  uploadLog: [],
  // Última sincronização
  lastSync: null,
  // Flag para evitar loops
  _rendering: false
};

// Caches para componentes
const caches = {
  tipoCounts: new Map(),
  bairroCounts: new Map(),
  naturezaCounts: new Map()
};

// Instâncias de gráficos
let chartInstances = {
  timeline: null,
  natureza: null,
  compMonth: null,
  compHour: null
};

// ============================================================
// 4. UTILITÁRIOS
// ============================================================

function fmtInt(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}

function fmtDateBR(iso) {
  if (!iso) return '—';
  const p = iso.split('-');
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function fmtDateShort(iso) {
  if (!iso) return '';
  const p = iso.split('-');
  return `${p[2]} ${MONTHS_PT[parseInt(p[1], 10) - 1]}`;
}

function fmtTime(h) {
  if (!h) return '—';
  return h.slice(0, 5);
}

function monthKeyLabel(mk) {
  const p = mk.split('-');
  return `${MONTHS_FULL_PT[parseInt(p[1], 10) - 1]}/${p[0]}`;
}

function titleCase(s) {
  if (!s) return '';
  return s.toLowerCase().split(' ').map((w, i) =>
    (i > 0 && SMALLWORDS.has(w)) ? w : (w.charAt(0).toUpperCase() + w.slice(1))
  ).join(' ');
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function parseISODate(iso) {
  const p = iso.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}

function toISODate(dt) {
  return dt.toISOString().slice(0, 10);
}

function addDays(dt, n) {
  const d2 = new Date(dt.getTime());
  d2.setUTCDate(d2.getUTCDate() + n);
  return d2;
}

function dayOfWeek(iso) {
  return parseISODate(iso).getUTCDay();
}

function weekKey(iso) {
  const dt = parseISODate(iso);
  const day = dt.getUTCDay();
  const diffToMonday = (day === 0 ? -6 : 1 - day);
  return toISODate(addDays(dt, diffToMonday));
}

function countDaysInRange(fromISO, toISO) {
  if (!fromISO || !toISO) return 0;
  const diff = Math.round((parseISODate(toISO) - parseISODate(fromISO)) / 86400000) + 1;
  return diff > 0 ? diff : 0;
}

function groupBy(arr, keyFn) {
  const map = new Map();
  for (const r of arr) {
    const k = keyFn(r);
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}

function movingAverage(arr, win) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - win + 1);
    const slice = arr.slice(start, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

function getDateRange(arr) {
  if (!arr.length) return [null, null];
  let min = arr[0].d, max = arr[0].d;
  for (const r of arr) {
    if (r.d < min) min = r.d;
    if (r.d > max) max = r.d;
  }
  return [min, max];
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function monthOf(iso) {
  return parseInt(iso.slice(5, 7), 10);
}

function csvEscape(s) {
  if (s === null || s === undefined) return '';
  const str = String(s);
  return /[;"\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
}

function normalizeBairroName(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim()
    .replace(/\s+/g, ' ');
}

const OFFICIAL_BAIRROS_SET = new Set(CONFIG.OFFICIAL_BAIRROS.map(normalizeBairroName));

function isOfficialBairro(name) {
  return OFFICIAL_BAIRROS_SET.has(normalizeBairroName(name));
}

// Variable for unique row keys inside closure scope
let _rowCounter = 0;

// ============================================================
// 5. PARSER DE DADOS
// ============================================================

const Parser = {
  normalizeHeader(s) {
    return String(s)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ');
  },

  parseDate(s) {
    if (!s) return '';
    const datePart = String(s).trim().split(' ')[0];

    if (datePart.includes('/')) {
      const p = datePart.split('/');
      if (p.length === 3) {
        if (p[0].length === 4) return `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
        return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
      }
    }

    if (datePart.includes('-')) {
      const p = datePart.split('-');
      if (p.length === 3) {
        if (p[0].length === 4) return `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
        return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
      }
    }

    return '';
  },

  parseTime(s) {
    if (!s) return '';
    const m = String(s).trim().match(/(\d{1,2}):(\d{2})/);
    if (!m) return '';
    return `${m[1].padStart(2, '0')}:${m[2]}`;
  },

  cleanRow(raw) {
    const d = this.parseDate(raw.data || '');
    if (!d) return null;

    const bo = (raw.bo || '').toString().trim().replace(/[.,]/g, '');
    const ano = (raw.ano || '').toString().trim() || d.slice(0, 4);
    const h = this.parseTime(raw.hora || '');
    const tf = (raw.tf || '').toString().trim() || 'NÃO INFORMADO';
    const nat = (raw.nat || '').toString().trim() || 'Sem Natureza';
    const b = (raw.b || '').toString().trim().toUpperCase() || 'NÃO INFORMADO';
    const r = (raw.r || '').toString().trim().toUpperCase() || 'NÃO INFORMADO';
    const end = (raw.end || '').toString().trim();
    const st = (raw.st || '').toString().trim();
    const vtr = (raw.vtr || '').toString().trim();

    return { bo, ano, d, h, tf, nat, b, r, end, st, vtr };
  },

  buildFieldLookup(keyMap) {
    const pick = (...names) => {
      for (const n of names) {
        if (keyMap[n] !== undefined) return keyMap[n];
      }
      return undefined;
    };

    return {
      bo: pick('bo', 'numero bo'),
      ano: pick('ano'),
      data: pick('data'),
      hora: pick('hora', 'ocorrencia'),
      tf: pick('tipo final'),
      nat: pick('natureza final', 'natureza'),
      b: pick('bairro'),
      r: pick('regional'),
      end: pick('endereco completo', 'endereco'),
      st: pick('sub tipo ocorrencia'),
      vtr: pick('vtr principal')
    };
  },
  
  buildKey(rec) {
    _rowCounter++;
    return `${rec.ano}|${rec.bo}|${rec.d}|${rec.h || '00:00'}|${_rowCounter}`;
  },

  parseRows(rows) {
    if (!rows || !rows.length) return { records: [], errors: [] };

    const keyMap = {};
    Object.keys(rows[0]).forEach(k => {
      keyMap[this.normalizeHeader(k)] = k;
    });

    const fl = this.buildFieldLookup(keyMap);

    if (!fl.data || !fl.bo) {
      return { records: [], errors: ['Colunas "BO" e "Data" não encontradas'] };
    }

    const records = [];
    let invalid = 0;

    for (const row of rows) {
      const mapped = {};
      for (const target of Object.keys(fl)) {
        mapped[target] = row[fl[target]];
      }
      const rec = this.cleanRow(mapped);
      if (rec) {
        records.push(rec);
      } else {
        invalid++;
      }
    }

    return { records, errors: invalid > 0 ? [`${invalid} linha(s) inválidas ignoradas`] : [] };
  }
};

// ============================================================
// 6. CARREGAMENTO DE DADOS
// ============================================================

const DataLoader = {
  async loadFromGoogleSheets(showToast = true) {
    try {
      UI.setSyncStatus('loading', 'Carregando planilha...');
      if (showToast) UI.showToast('Atualizando dados', 'Buscando planilha...', false);

      const response = await fetch(CONFIG.SHEET_URL, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      let csvText = await response.text();

      if (csvText.charCodeAt(0) === 0xFEFF) {
        csvText = csvText.slice(1);
      }

      const result = Papa.parse(csvText, {
        header: true,
        delimiter: '',
        skipEmptyLines: true
      });

      if (result.errors && result.errors.length) {
        console.warn('Erros no parse do CSV:', result.errors);
      }

      if (!result.data || result.data.length === 0) {
        throw new Error('Nenhuma linha encontrada na planilha');
      }

      const parsed = Parser.parseRows(result.data);
      if (parsed.errors.length) {
        console.warn('Erros no parser:', parsed.errors);
      }

      if (!parsed.records.length) {
        throw new Error('Nenhum registro válido encontrado');
      }

      const merged = this.mergeRecords(parsed.records);

      UI.setSyncStatus('ok', `Atualizado: ${new Date().toLocaleString('pt-BR')}`);
      if (showToast) {
        UI.showToast('Dados updated', `${fmtInt(state.all.length)} registros carregados`, false);
      }

      return merged;

    } catch (err) {
      console.error('Erro ao carregar planilha:', err);
      UI.setSyncStatus('err', 'Falha ao carregar planilha');
      if (showToast) {
        UI.showToast('Erro na planilha', err.message || 'Não foi possível carregar os dados.', true);
      }
      return false;
    }
  },

  mergeRecords(records) {
    // Reseta os buckets atuais para carregar a versão mais recente da planilha na íntegra
    state.monthBuckets = {};
    
    const byMonth = {};
    for (const rec of records) {
      const mk = rec.d.slice(0, 7);
      (byMonth[mk] = byMonth[mk] || []).push(rec);
    }

    for (const mk of Object.keys(byMonth)) {
      state.monthBuckets[mk] = byMonth[mk];
    }

    // Reconstruir o array completo do estado global com todos os dados
    this.rebuildAll();

    // Registrar no histórico de sincronização da modal
    const entry = {
      filename: 'Google Sheets',
      timestamp: new Date().toISOString(),
      added: records.length,
      updated: 0,
      months: Object.keys(byMonth).sort()
    };
    state.uploadLog = [entry, ...state.uploadLog].slice(0, 20);
    state.lastSync = new Date().toISOString();

    // Atualizar metadados dos filtros
    Metadata.refresh();

    return { added: records.length, updated: 0 };
  },

  rebuildAll() {
    state.all = [];
    for (const mk of Object.keys(state.monthBuckets)) {
      state.all.push(...state.monthBuckets[mk]);
    }
    state.all.sort((a, b) =>
      a.d === b.d ? (a.h || '').localeCompare(b.h || '') : a.d.localeCompare(b.d)
    );
  }
};

// ============================================================
// 7. METADADOS
// ============================================================

const Metadata = {
  refresh() {
    const tipos = new Set();
    const bairros = new Set();
    const regionais = new Set();
    const naturezas = new Set();

    for (const r of state.all) {
      if (r.tf) tipos.add(r.tf);
      if (r.b) bairros.add(r.b);
      if (r.r) regionais.add(r.r);
      if (r.nat) naturezas.add(r.nat);
    }

    state.meta.tipos = Array.from(tipos).sort();
    state.meta.bairros = Array.from(bairros).sort();
    state.meta.regionais = Array.from(regionais).sort();
    state.meta.naturezas = Array.from(naturezas).sort();

    caches.tipoCounts = groupBy(state.all, r => r.tf);
    caches.bairroCounts = this.computeBairroCounts();
    caches.naturezaCounts = groupBy(state.all, r => r.nat);

    FilterUI.refreshOptions();
  },

  computeBairroCounts() {
    const rows = state.filters.bairroOficial
      ? state.all.filter(r => isOfficialBairro(r.b))
      : state.all;
    return groupBy(rows, r => r.b);
  }
};

// ============================================================
// 8. FILTROS
// ============================================================

const Filters = {
  apply() {
    const { dateFrom, dateTo, tipos, bairros, regional, natureza, bairroOficial } = state.filters;

    state.filtered = state.all.filter(r => {
      if (dateFrom && r.d < dateFrom) return false;
      if (dateTo && r.d > dateTo) return false;
      if (regional && r.r !== regional) return false;
      if (natureza && r.nat !== natureza) return false;
      if (tipos !== null && !tipos.has(r.tf)) return false;
      if (bairros !== null && !bairros.has(r.b)) return false;
      if (bairroOficial && !isOfficialBairro(r.b)) return false;
      return true;
    });

    return state.filtered;
  },

  applyIgnoringDate() {
    const { tipos, bairros, regional, natureza, bairroOficial } = state.filters;

    return state.all.filter(r => {
      if (regional && r.r !== regional) return false;
      if (natureza && r.nat !== natureza) return false;
      if (tipos !== null && !tipos.has(r.tf)) return false;
      if (bairros !== null && !bairros.has(r.b)) return false;
      if (bairroOficial && !isOfficialBairro(r.b)) return false;
      return true;
    });
  },

  reset() {
    const [minD, maxD] = getDateRange(state.all);
    
    state.filters.dateFrom = minD || null;
    state.filters.dateTo = maxD || null;
    state.filters.tipos = null;
    state.filters.bairros = null;
    state.filters.regional = '';
    state.filters.natureza = null;
    state.filters.bairroOficial = false;

    const dateFromEl = document.getElementById('dateFrom');
    const dateToEl = document.getElementById('dateTo');
    const regionalEl = document.getElementById('regionalSelect');
    const bairroOficialEl = document.getElementById('bairroOficialToggle');
    const bairroOficialWrapEl = document.getElementById('bairroOficialWrap');
    
    if (dateFromEl) dateFromEl.value = minD || '';
    if (dateToEl) dateToEl.value = maxD || '';
    if (regionalEl) regionalEl.value = '';
    if (bairroOficialEl) bairroOficialEl.checked = false;
    if (bairroOficialWrapEl) bairroOficialWrapEl.classList.remove('active');

    Metadata.refresh();
    FilterUI.refreshChecklists();
    Dashboard.render();
  },

  setDateRange(from, to) {
    state.filters.dateFrom = from;
    state.filters.dateTo = to;
  },
  
  isFilterActive(key) {
    const value = state.filters[key];
    if (key === 'regional') return value !== '';
    if (key === 'natureza') return value !== null;
    if (key === 'tipos' || key === 'bairros') return value !== null;
    if (key === 'bairroOficial') return value === true;
    return false;
  }
};

// ============================================================
// 9. UI - FILTERS
// ============================================================

const FilterUI = {
  refreshOptions() {
    const regSel = document.getElementById('regionalSelect');
    if (!regSel) return;
    
    const currentVal = regSel.value;
    regSel.innerHTML = '<option value="">Regional: todas</option>';

    const counts = groupBy(state.all, r => r.r);
    Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .forEach(([name, count]) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${titleCase(name)} (${fmtInt(count)})`;
        regSel.appendChild(opt);
      });

    if (Array.from(regSel.options).some(o => o.value === currentVal)) {
      regSel.value = currentVal;
    }

    this.refreshChecklists();
  },

  refreshChecklists() {
    this.buildList('tipoList', caches.tipoCounts, 'tipo');
    this.buildList('bairroList', caches.bairroCounts, 'bairro');
    this.updateCounts();
  },

  buildList(listId, countsMap, target) {
    const container = document.getElementById(listId);
    if (!container) return;
    
    let activeSet = target === 'tipo' ? state.filters.tipos : state.filters.bairros;
    const allNames = new Set(countsMap.keys());
    const isAllSelected = (activeSet === null);
    const displaySet = isAllSelected ? allNames : activeSet;
    const sorted = Array.from(countsMap.entries()).sort((a, b) => b[1] - a[1]);

    const frag = document.createDocumentFragment();
    for (const [name, count] of sorted) {
      const row = document.createElement('label');
      row.className = 'msel-item';
      row.dataset.name = name.toLowerCase();

      const checked = displaySet ? displaySet.has(name) : false;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = checked;
      cb.dataset.target = target;
      cb.dataset.name = name;

      const span = document.createElement('span');
      span.textContent = titleCase(name);

      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = fmtInt(count);

      row.appendChild(cb);
      row.appendChild(span);
      row.appendChild(n);
      frag.appendChild(row);
    }

    container.innerHTML = '';
    container.appendChild(frag);
  },

  updateCounts() {
    const tipoEl = document.getElementById('tipoCount');
    const bairroEl = document.getElementById('bairroCount');

    if (tipoEl) {
      const tipoSet = state.filters.tipos;
      tipoEl.textContent = tipoSet === null ? 'todos' : `${tipoSet.size} sel.`;
    }
    
    if (bairroEl) {
      const bairroSet = state.filters.bairros;
      bairroEl.textContent = bairroSet === null ? 'todos' : `${bairroSet.size} sel.`;
    }
  },

  toggleItem(target, name, checked) {
    const key = target === 'tipo' ? 'tipos' : 'bairros';
    const allNames = new Set((target === 'tipo' ? caches.tipoCounts : caches.bairroCounts).keys());

    let cur = state.filters[key];
    if (cur === null) {
      cur = new Set(allNames);
    } else {
      cur = new Set(cur);
    }

    if (checked) {
      cur.add(name);
    } else {
      cur.delete(name);
    }

    state.filters[key] = (cur.size === allNames.size) ? null : cur;

    this.updateCounts();
    Dashboard.render();
  },

  setAll(target, mode) {
    const key = target === 'tipo' ? 'tipos' : 'bairros';
    
    if (mode === 'all') {
      state.filters[key] = null;
    } else {
      state.filters[key] = new Set();
    }

    this.buildList(
      target === 'tipo' ? 'tipoList' : 'bairroList',
      target === 'tipo' ? caches.tipoCounts : caches.bairroCounts,
      target
    );
    
    this.updateCounts();
    Dashboard.render();
  },

  syncChecklist(target) {
    this.buildList(
      target === 'tipo' ? 'tipoList' : 'bairroList',
      target === 'tipo' ? caches.tipoCounts : caches.bairroCounts,
      target
    );
    this.updateCounts();
  },

  setBairroOficial(checked) {
    state.filters.bairroOficial = checked;
    state.filters.bairros = null; // reset seleção, pois o universo de opções mudou
    caches.bairroCounts = Metadata.computeBairroCounts();
    this.refreshChecklists();
    Dashboard.render();
  }
};

// ============================================================
// 10. UI - TOAST, SYNC, MODAL
// ============================================================

const UI = {
  showToast(title, msg, isErr = false) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.className = 'toast' + (isErr ? ' err' : '');
    el.innerHTML = `
      <div style="flex:1"><strong>${escapeHtml(title)}</strong>${escapeHtml(msg)}</div>
      <span class="close">×</span>
    `;

    el.querySelector('.close').addEventListener('click', () => el.remove());
    document.body.appendChild(el);

    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 6000);
  },

  setSyncStatus(status, label) {
    const dot = document.getElementById('syncDot');
    const lbl = document.getElementById('syncLabel');
    dot.className = 'dot';

    if (status === 'ok') {
      dot.classList.add('ok');
      lbl.textContent = label || 'Planilha sincronizada';
    } else if (status === 'loading') {
      dot.classList.add('loading');
      lbl.textContent = label || 'Carregando...';
    } else {
      dot.classList.add('err');
      lbl.textContent = label || 'Erro na sincronização';
    }
  },

  openModal() {
    document.getElementById('uploadModal').classList.add('open');
    this.renderUploadLog();
  },

  closeModal() {
    document.getElementById('uploadModal').classList.remove('open');
  },

  renderUploadLog() {
    const list = document.getElementById('uploadLogList');
    list.innerHTML = '';

    if (!state.uploadLog.length) {
      list.innerHTML = '<div style="color:var(--text-dim); font-size:12px; padding:8px 0;">Nenhuma sincronização registrada.</div>';
      return;
    }

    for (const entry of state.uploadLog) {
      const row = document.createElement('div');
      row.className = 'upload-log-row';
      const dt = new Date(entry.timestamp);
      const dtLabel = isNaN(dt.getTime()) ? '' :
        dt.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

      const label = entry.filename || 'Sincronização';
      row.innerHTML = `
        <span class="f">${escapeHtml(label)} · ${dtLabel}</span>
        <span class="c">${fmtInt(entry.added || 0)} registros</span>
      `;
      list.appendChild(row);
    }
  },

  updateHeader() {
    const [minD, maxD] = getDateRange(state.all);
    const el = document.getElementById('periodLabel');
    if (!minD) {
      el.textContent = 'sem dados carregados';
      return;
    }
    el.innerHTML = `${fmtDateBR(minD)} — ${fmtDateBR(maxD)}<span class="dot">·</span>${Object.keys(state.monthBuckets).length} mês(es)`;
  },

  updateTotalPill() {
    document.getElementById('totalPill').textContent = `${fmtInt(state.all.length)} registros`;
  }
};

// ============================================================
// 11. KPI RENDERER
// ============================================================

const KPI = {
  render(filtered) {
    const total = filtered.length;
    document.getElementById('kpiTotal').textContent = fmtInt(total);

    const days = countDaysInRange(state.filters.dateFrom, state.filters.dateTo);
    const avg = days > 0 ? total / days : 0;
    document.getElementById('kpiAvg').textContent = avg.toFixed(1).replace('.', ',');
    document.getElementById('kpiAvgSub').textContent = days > 0 ? `em ${fmtInt(days)} dias` : '—';

    // Horário de pico
    const hourCounts = Array(24).fill(0);
    for (const r of filtered) {
      if (!r.h) continue;
      const hh = parseInt(r.h.slice(0, 2), 10);
      if (!isNaN(hh) && hh >= 0 && hh <= 23) hourCounts[hh]++;
    }
    let peakH = -1, peakV = 0;
    for (let h = 0; h < 24; h++) {
      if (hourCounts[h] > peakV) { peakV = hourCounts[h]; peakH = h; }
    }
    const kpiPeakHourEl = document.getElementById('kpiPeakHour');
    const kpiPeakHourSubEl = document.getElementById('kpiPeakHourSub');
    if (kpiPeakHourEl) kpiPeakHourEl.textContent = peakH >= 0 ? `${String(peakH).padStart(2, '0')}:00` : '—';
    if (kpiPeakHourSubEl) kpiPeakHourSubEl.textContent = peakV > 0 ? `${fmtInt(peakV)} ocorrências` : '—';

    // Bairro mais acionado
    const bairroCounts = groupBy(filtered, r => r.b);
    const topBairro = Array.from(bairroCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    const kpiTopBairroEl = document.getElementById('kpiTopBairro');
    const kpiTopBairroSubEl = document.getElementById('kpiTopBairroSub');
    if (kpiTopBairroEl) kpiTopBairroEl.textContent = topBairro ? titleCase(topBairro[0]) : '—';
    if (kpiTopBairroSubEl) kpiTopBairroSubEl.textContent = topBairro ? `${fmtInt(topBairro[1])} ocorrências` : '—';

    // Tipo Final mais frequente
    const tipoCounts = groupBy(filtered, r => r.tf);
    const topTipo = Array.from(tipoCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    const kpiTopTipoEl = document.getElementById('kpiTopTipo');
    const kpiTopTipoSubEl = document.getElementById('kpiTopTipoSub');
    if (kpiTopTipoEl) kpiTopTipoEl.textContent = topTipo ? titleCase(topTipo[0]) : '—';
    if (kpiTopTipoSubEl) kpiTopTipoSubEl.textContent = topTipo ? `${fmtInt(topTipo[1])} ocorrências` : '—';
  }
};

// ============================================================
// 12. TIMELINE RENDERER
// ============================================================

const Timeline = {
  buildDailySeries(filtered, from, to) {
    if (!from || !to) return [];
    const map = groupBy(filtered, r => r.d);
    const series = [];
    let cur = parseISODate(from);
    const end = parseISODate(to);

    while (cur <= end) {
      const iso = toISODate(cur);
      series.push({ d: iso, c: map.get(iso) || 0 });
      cur = addDays(cur, 1);
    }
    return series;
  },

  render(filtered) {
    const canvas = document.getElementById('timelineChart');
    if (!canvas) return;

    if (chartInstances.timeline) {
      chartInstances.timeline.destroy();
    }

    const gran = state.view.granularity;
    let labels = [], dataPoints = [], maPoints = [];
    let type = 'line';

    if (gran === 'day') {
      const series = this.buildDailySeries(filtered, state.filters.dateFrom, state.filters.dateTo);
      labels = series.map(s => fmtDateShort(s.d));
      dataPoints = series.map(s => s.c);
      maPoints = dataPoints.length ? movingAverage(dataPoints, 7) : [];
    } else if (gran === 'week') {
      const m = groupBy(filtered, r => weekKey(r.d));
      const keys = Array.from(m.keys()).sort();
      labels = keys.map(fmtDateShort);
      dataPoints = keys.map(k => m.get(k));
    } else {
      const m = groupBy(filtered, r => r.d.slice(0, 7));
      const keys = Array.from(m.keys()).sort();
      labels = keys.map(monthKeyLabel);
      dataPoints = keys.map(k => m.get(k));
      type = 'bar';
    }

    const datasets = [{
      label: 'Ocorrências',
      data: dataPoints,
      borderColor: '#3fb8ab',
      backgroundColor: type === 'bar' ? 'rgba(63,184,171,0.55)' : 'rgba(63,184,171,0.12)',
      fill: type !== 'bar',
      tension: 0.3,
      pointRadius: 0,
      pointHoverRadius: 4,
      borderWidth: 2,
      borderRadius: type === 'bar' ? 3 : 0
    }];

    if (maPoints && maPoints.length) {
      datasets.push({
        label: 'Média móvel (7 dias)',
        data: maPoints,
        borderColor: '#e8a84a',
        borderWidth: 1.5,
        borderDash: [4, 3],
        pointRadius: 0,
        fill: false,
        tension: 0.3
      });
    }

    chartInstances.timeline = new Chart(canvas.getContext('2d'), {
      type,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0a1218',
            borderColor: '#24333f',
            borderWidth: 1,
            titleColor: '#e7edf2',
            bodyColor: '#e7edf2',
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 }
          }
        },
        scales: {
          x: { grid: { color: '#1c2a35' }, ticks: { maxRotation: 0, font: { size: 10 } } },
          y: { grid: { color: '#1c2a35' }, ticks: { font: { size: 10 } }, beginAtZero: true }
        }
      }
    });
  }
};

// ============================================================
// 13. HEATMAP RENDERER
// ============================================================

const Heatmap = {
  render(filtered) {
    const grid = document.getElementById('heatGrid');
    if (!grid) return;
    grid.innerHTML = '';
    grid.appendChild(document.createElement('div'));

    for (let h = 0; h < 24; h++) {
      const lbl = document.createElement('div');
      lbl.className = 'heat-hourlabel';
      lbl.textContent = (h % 3 === 0) ? String(h).padStart(2, '0') : '';
      grid.appendChild(lbl);
    }

    const counts = Array.from({ length: 7 }, () => Array(24).fill(0));
    for (const r of filtered) {
      if (!r.h) continue;
      const hh = parseInt(r.h.slice(0, 2), 10);
      if (isNaN(hh) || hh < 0 || hh > 23) continue;
      counts[dayOfWeek(r.d)][hh]++;
    }

    let max = 0;
    for (const row of counts) {
      for (const v of row) {
        if (v > max) max = v;
      }
    }

    for (let d = 0; d < 7; d++) {
      const dayLbl = document.createElement('div');
      dayLbl.className = 'heat-daylabel';
      dayLbl.textContent = WEEKDAYS_PT[d];
      grid.appendChild(dayLbl);

      for (let h = 0; h < 24; h++) {
        const v = counts[d][h];
        const cell = document.createElement('div');
        cell.className = 'heat-cell';
        cell.style.background = this.getColor(v, max);
        cell.addEventListener('mousemove', (e) => {
          this.showTooltip(e, `${WEEKDAYS_PT[d]} ${String(h).padStart(2, '0')}h — <b>${fmtInt(v)}</b>`);
        });
        cell.addEventListener('mouseleave', () => this.hideTooltip());
        grid.appendChild(cell);
      }
    }

    let peakH = 0, peakD = 0, peakVal = 0;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (counts[d][h] > peakVal) {
          peakVal = counts[d][h];
          peakH = h;
          peakD = d;
        }
      }
    }

    document.getElementById('heatPeakHour').textContent = peakVal > 0 ? `${String(peakH).padStart(2, '0')}:00` : '—';
    document.getElementById('heatPeakDay').textContent = peakVal > 0 ? WEEKDAYS_PT[peakD] : '—';

    const hourTotals = Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      for (let d = 0; d < 7; d++) {
        hourTotals[h] += counts[d][h];
      }
    }

    let minH = 0, minV = Infinity;
    for (let h = 0; h < 24; h++) {
      if (hourTotals[h] < minV) {
        minV = hourTotals[h];
        minH = h;
      }
    }
    document.getElementById('heatQuiet').textContent = filtered.length ? `${String(minH).padStart(2, '0')}:00` : '—';
  },

  getColor(v, max) {
    if (!v) return 'rgb(22, 35, 44)';
    if (!max) return 'rgb(22, 35, 44)';
    const pct = v / max;
    const colors = CONFIG.HEATMAP_COLORS;
    const idx = Math.min(Math.floor(pct * (colors.length - 1)), colors.length - 2);
    const c1 = colors[idx], c2 = colors[idx + 1];
    const base = idx / (colors.length - 1);
    const range = 1 / (colors.length - 1);
    const f = (pct - base) / range;

    const r = Math.round(c1[0] + (c2[0] - c1[0]) * f);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * f);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * f);
    return `rgb(${r},${g},${b})`;
  },

  showTooltip(e, html) {
    const el = document.getElementById('floatTooltip');
    if (!el) return;
    el.innerHTML = html;
    el.style.display = 'block';
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + 180 > window.innerWidth) x = e.clientX - 190;
    if (y + 60 > window.innerHeight) y = e.clientY - 60;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  },

  hideTooltip() {
    const el = document.getElementById('floatTooltip');
    if (el) el.style.display = 'none';
  }
};

// ============================================================
// 14. RANKING RENDERER
// ============================================================

const Ranking = {
  render(containerId, filtered, keyFn, activeSet, onClick, topN = CONFIG.RANK_TOP_N) {
    const counts = groupBy(filtered, keyFn);
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (!sorted.length) {
      container.innerHTML = this.emptyState();
      return;
    }

    const top = sorted.slice(0, topN);
    const restSum = sorted.slice(topN).reduce((s, e) => s + e[1], 0);
    const maxVal = sorted[0][1];

    const frag = document.createDocumentFragment();
    for (const [name, count] of top) {
      const p = maxVal > 0 ? (count / maxVal * 100) : 0;
      const row = document.createElement('div');
      row.className = 'rankbar-row';
      if (activeSet && activeSet.has(name)) row.classList.add('active');

      row.innerHTML = `
        <div class="rankbar-top">
          <span class="name">${escapeHtml(titleCase(name))}</span>
          <span class="val">${fmtInt(count)}</span>
        </div>
        <div class="rankbar-track"><div class="rankbar-fill" style="width:${p}%"></div></div>
      `;

      if (onClick) {
        row.addEventListener('click', () => onClick(name));
      }
      frag.appendChild(row);
    }

    if (restSum > 0) {
      const row = document.createElement('div');
      row.className = 'rankbar-row rest';
      row.innerHTML = `
        <div class="rankbar-top">
          <span class="name">Outros (${sorted.length - topN})</span>
          <span class="val">${fmtInt(restSum)}</span>
        </div>
      `;
      frag.appendChild(row);
    }

    container.appendChild(frag);
  },

  emptyState() {
    return `<div style="color:var(--text-dim); font-size:12px; padding:20px; text-align:center;">Nenhum registro</div>`;
  }
};

// ============================================================
// 15. NATUREZA RENDERER
// ============================================================

const Natureza = {
  render(filtered) {
    const counts = groupBy(filtered, r => r.nat);
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    const labels = sorted.map(s => s[0]);
    const data = sorted.map(s => s[1]);
    const colors = labels.map((_, i) => CONFIG.NATUREZA_COLORS[i % CONFIG.NATUREZA_COLORS.length]);
    const canvas = document.getElementById('naturezaChart');
    if (!canvas) return;

    if (chartInstances.natureza) {
      chartInstances.natureza.destroy();
    }

    if (!labels.length) {
      document.getElementById('naturezaLegend').innerHTML = `<span style="color:var(--text-dim); font-size:12px;">Sem dados</span>`;
      return;
    }

    chartInstances.natureza = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderColor: '#141f2a', borderWidth: 2 }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0a1218',
            borderColor: '#24333f',
            borderWidth: 1,
            titleColor: '#e7edf2',
            bodyColor: '#e7edf2',
            titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
            bodyFont: { family: "'JetBrains Mono', monospace", size: 11 }
          }
        },
        onClick: (evt, elements) => {
          if (elements.length) {
            const idx = elements[0].index;
            this.onClick(labels[idx]);
          }
        }
      }
    });

    const legend = document.getElementById('naturezaLegend');
    legend.innerHTML = '';
    const total = data.reduce((a, b) => a + b, 0);

    labels.forEach((lab, i) => {
      const row = document.createElement('div');
      row.className = 'donut-legend-row';
      if (state.filters.natureza === lab) {
        row.style.color = 'var(--accent)';
      }
      row.innerHTML = `
        <span class="sw" style="background:${colors[i]}"></span>
        <span class="lname">${escapeHtml(lab)}</span>
        <span class="lval">${total ? (data[i] / total * 100).toFixed(0) : 0}%</span>
      `;
      row.addEventListener('click', () => this.onClick(lab));
      legend.appendChild(row);
    });
  },

  onClick(name) {
    state.filters.natureza = state.filters.natureza === name ? null : name;
    Dashboard.render();
  }
};

// ============================================================
// 16. TABELA MENSAL RENDERER
// ============================================================

const MonthTable = {
  render() {
    const tbody = document.getElementById('monthTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const months = Object.keys(state.monthBuckets).sort();
    let prevTotal = null;

    for (const mk of months) {
      const allMonthRows = state.monthBuckets[mk];
      const filtered = allMonthRows.filter(r => {
        if (state.filters.tipos !== null && !state.filters.tipos.has(r.tf)) return false;
        if (state.filters.bairros !== null && !state.filters.bairros.has(r.b)) return false;
        if (state.filters.regional && r.r !== state.filters.regional) return false;
        if (state.filters.natureza && r.nat !== state.filters.natureza) return false;
        if (state.filters.bairroOficial && !isOfficialBairro(r.b)) return false;
        return true;
      });

      const total = filtered.length;
      const tfs = groupBy(filtered, r => r.tf);
      const topTf = Array.from(tfs.entries()).sort((a, b) => b[1] - a[1])[0];

      let deltaHtml = '—';
      if (prevTotal !== null && prevTotal > 0) {
        const pct = ((total - prevTotal) / prevTotal) * 100;
        const sign = pct >= 0 ? '+' : '';
        deltaHtml = `<span class="${pct >= 0 ? 'delta-up' : 'delta-down'}">${sign}${pct.toFixed(0)}%</span>`;
      }

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="month-name">${monthKeyLabel(mk)}</td>
        <td class="num">${fmtInt(total)}</td>
        <td>${deltaHtml}</td>
        <td>${escapeHtml(titleCase(topTf ? topTf[0] : '—'))}</td>
      `;
      tbody.appendChild(tr);
      prevTotal = total;
    }
  }
};

// ============================================================
// 17. COMPARATIVO ANUAL RENDERER
// ============================================================

const Comparativo = {
  render() {
    const allData = state.all;
    const hint = document.getElementById('compHint');
    if (!hint) return;

    const anos = new Set();
    for (const r of allData) {
      anos.add(r.ano);
    }
    const anosArray = Array.from(anos).sort();

    if (anosArray.length < 2) {
      hint.textContent = 'dados insuficientes para comparar (necessário 2+ anos)';
      document.getElementById('compKpis').innerHTML = '';
      document.getElementById('compTipoList').innerHTML = Ranking.emptyState();
      document.getElementById('compBairroList').innerHTML = Ranking.emptyState();
      if (chartInstances.compMonth) chartInstances.compMonth.destroy();
      if (chartInstances.compHour) chartInstances.compHour.destroy();
      return;
    }

    const anoBase = anosArray[0];
    const anoCurr = anosArray[anosArray.length - 1];

    // Se o usuário escolheu um período nos filtros de data, usamos os meses
    // desse período como janela da comparação (permite comparar, por exemplo,
    // só Jan-Mar, ou um Tipo Final específico só naquele intervalo).
    // Sem período escolhido, cai no comportamento padrão: todos os meses com
    // dados no ano mais recente.
    const mesesPresentes = new Set();
    const { dateFrom, dateTo } = state.filters;

    if (dateFrom && dateTo) {
      const mIni = monthOf(dateFrom);
      const mFim = monthOf(dateTo);
      if (mIni <= mFim) {
        for (let m = mIni; m <= mFim; m++) mesesPresentes.add(m);
      } else {
        // período atravessa a virada do ano (ex.: Nov -> Fev)
        for (let m = mIni; m <= 12; m++) mesesPresentes.add(m);
        for (let m = 1; m <= mFim; m++) mesesPresentes.add(m);
      }
    } else {
      for (const r of allData) {
        if (r.ano === anoCurr) {
          mesesPresentes.add(monthOf(r.d));
        }
      }
    }

    const rangeLbl = this.monthRangeLabel(mesesPresentes);
    const tipoSet = state.filters.tipos;
    const tipoLabel = (tipoSet && tipoSet.size === 1)
      ? ` · Tipo Final: ${titleCase(Array.from(tipoSet)[0])}`
      : '';
    hint.textContent = `mesmo período (${rangeLbl}) comparado entre ${anoBase} e ${anoCurr}${tipoLabel}`;

    document.getElementById('legendYearBase').textContent = anoBase;
    document.getElementById('legendYearCurr').textContent = anoCurr;
    document.getElementById('tipoCompYearsLabel').textContent = `${anoBase} vs ${anoCurr}`;
    document.getElementById('bairroCompYearsLabel').textContent = `${anoBase} vs ${anoCurr}`;

    const dataIgnDate = Filters.applyIgnoringDate();
    const dataBase = dataIgnDate.filter(r => r.ano === anoBase && mesesPresentes.has(monthOf(r.d)));
    const dataCurr = dataIgnDate.filter(r => r.ano === anoCurr);

    const totBase = dataBase.length;
    const totCurr = dataCurr.length;

    let deltaHtml = '—', deltaClass = '';
    if (totBase > 0) {
      const pct = ((totCurr - totBase) / totBase) * 100;
      deltaClass = pct >= 0 ? 'delta-up' : 'delta-down';
      deltaHtml = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    }

    document.getElementById('compKpis').innerHTML = `
      ${this.kpiCell(String(anoBase), fmtInt(totBase), 'total no período')}
      ${this.kpiCell(String(anoCurr), fmtInt(totCurr), 'total no período')}
      ${this.kpiCell('Variação', deltaHtml, 'entre períodos', deltaClass)}
    `;

    this.renderMonthChart(dataBase, dataCurr, anoBase, anoCurr, mesesPresentes);
    this.renderHourChart(dataBase, dataCurr, anoBase, anoCurr);
    this.renderCompRank('compTipoList', dataBase, dataCurr, r => r.tf, anoBase, anoCurr);
    this.renderCompRank('compBairroList', dataBase, dataCurr, r => r.b, anoBase, anoCurr);
  },

  monthRangeLabel(monthSet) {
    if (!monthSet.size) return '—';
    const arr = Array.from(monthSet).sort((a, b) => a - b);
    const min = arr[0], max = arr[arr.length - 1];
    return min === max ? MONTHS_PT[min - 1] : `${MONTHS_PT[min - 1]}–${MONTHS_PT[max - 1]}`;
  },

  kpiCell(label, value, sub, deltaClass) {
    return `<div class="comp-kpi">
      <div class="l">${escapeHtml(label)}</div>
      <div class="v${deltaClass ? (' ' + deltaClass) : ''}">${value}</div>
      <div class="s">${escapeHtml(sub)}</div>
    </div>`;
  },

  renderMonthChart(dataBase, dataCurr, anoBase, anoCurr, mesesPresentes) {
    const mBase = groupBy(dataBase, r => monthOf(r.d));
    const mCurr = groupBy(dataCurr, r => monthOf(r.d));
    const dataBaseArr = [], dataCurrArr = [];

    for (let m = 1; m <= 12; m++) {
      dataBaseArr.push(mBase.get(m) || 0);
      dataCurrArr.push(mesesPresentes.has(m) ? (mCurr.get(m) || 0) : null);
    }

    const ctx = document.getElementById('compMonthChart').getContext('2d');
    if (chartInstances.compMonth) {
      chartInstances.compMonth.destroy();
    }

    chartInstances.compMonth = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: MONTHS_PT,
        datasets: [
          { label: String(anoBase), data: dataBaseArr, backgroundColor: 'rgba(232,168,74,0.55)', borderRadius: 3, maxBarThickness: 26 },
          { label: String(anoCurr), data: dataCurrArr, backgroundColor: 'rgba(63,184,171,0.55)', borderRadius: 3, maxBarThickness: 26 }
        ]
      },
      options: this.chartOptions()
    });
  },

  renderHourChart(dataBase, dataCurr, anoBase, anoCurr) {
    const hcBase = Array(24).fill(0), hcCurr = Array(24).fill(0);
    for (const r of dataBase) {
      if (r.h) { const hh = parseInt(r.h.slice(0, 2), 10); if (!isNaN(hh)) hcBase[hh]++; }
    }
    for (const r of dataCurr) {
      if (r.h) { const hh = parseInt(r.h.slice(0, 2), 10); if (!isNaN(hh)) hcCurr[hh]++; }
    }

    const totBase = hcBase.reduce((a, b) => a + b, 0) || 1;
    const totCurr = hcCurr.reduce((a, b) => a + b, 0) || 1;
    const pctBase = hcBase.map(v => +(v / totBase * 100).toFixed(2));
    const pctCurr = hcCurr.map(v => +(v / totCurr * 100).toFixed(2));
    const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}h`);

    const ctx = document.getElementById('compHourChart').getContext('2d');
    if (chartInstances.compHour) {
      chartInstances.compHour.destroy();
    }

    chartInstances.compHour = new Chart(ctx, {
      type: 'line',
      data: {
        labels: hourLabels,
        datasets: [
          { label: String(anoBase), data: pctBase, borderColor: '#e8a84a', backgroundColor: 'rgba(232,168,74,0.08)', borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, tension: 0.35, fill: false },
          { label: String(anoCurr), data: pctCurr, borderColor: '#3fb8ab', backgroundColor: 'rgba(63,184,171,0.12)', borderWidth: 2, pointRadius: 0, tension: 0.35, fill: true }
        ]
      },
      options: this.chartOptions()
    });
  },

  renderCompRank(containerId, dataBase, dataCurr, keyFn, anoBase, anoCurr, topN = 8) {
    const cBase = groupBy(dataBase, keyFn);
    const cCurr = groupBy(dataCurr, keyFn);
    const allKeys = new Set([...cBase.keys(), ...cCurr.keys()]);

    const rows = [];
    for (const k of allKeys) {
      const vBase = cBase.get(k) || 0;
      const vCurr = cCurr.get(k) || 0;
      rows.push({ k, vBase, vCurr });
    }

    rows.sort((a, b) => b.vCurr - a.vCurr);
    const top = rows.slice(0, topN);

    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (!top.length) {
      container.innerHTML = Ranking.emptyState();
      return;
    }

    const maxVal = top.reduce((m, r) => Math.max(m, r.vBase, r.vCurr), 0) || 1;
    const tagBase = String(anoBase);
    const tagCurr = String(anoCurr);

    const frag = document.createDocumentFragment();
    for (const r of top) {
      let deltaHtml, deltaClass;
      if (r.vBase === 0 && r.vCurr > 0) {
        deltaHtml = 'novo';
        deltaClass = 'delta-new';
      } else if (r.vBase > 0) {
        const p = ((r.vCurr - r.vBase) / r.vBase) * 100;
        deltaClass = p >= 0 ? 'delta-up' : 'delta-down';
        deltaHtml = `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`;
      } else {
        deltaHtml = '—';
        deltaClass = '';
      }

      const pBase = maxVal > 0 ? (r.vBase / maxVal * 100) : 0;
      const pCurr = maxVal > 0 ? (r.vCurr / maxVal * 100) : 0;

      const el = document.createElement('div');
      el.className = 'comp-row';
      el.innerHTML = `
        <div class="comp-row-head">
          <span class="name">${escapeHtml(titleCase(r.k))}</span>
          <span class="delta ${deltaClass}">${deltaHtml}</span>
        </div>
        <div class="comp-bars">
          <div class="comp-bar-line">
            <span class="tag">${tagBase}</span>
            <div class="comp-bar-track"><div class="comp-bar-fill y25" style="width:${pBase}%"></div></div>
            <span class="val">${fmtInt(r.vBase)}</span>
          </div>
          <div class="comp-bar-line">
            <span class="tag">${tagCurr}</span>
            <div class="comp-bar-track"><div class="comp-bar-fill y26" style="width:${pCurr}%"></div></div>
            <span class="val">${fmtInt(r.vCurr)}</span>
          </div>
        </div>
      `;
      frag.appendChild(el);
    }
    container.appendChild(frag);
  },

  chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0a1218', borderColor: '#24333f', borderWidth: 1,
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 }
        }
      },
      scales: {
        x: { grid: { color: '#1c2a35' }, ticks: { font: { size: 10 } } },
        y: { grid: { color: '#1c2a35' }, ticks: { font: { size: 10 } } }
      }
    };
  }
};

// ============================================================
// 18. LOG TABLE RENDERER
// ============================================================

const LogTable = {
  render() {
    let rows = state.filtered.slice();
    const search = (state.log.search || '').toLowerCase();

    if (search) {
      rows = rows.filter(r =>
        (r.bo || '').toLowerCase().includes(search) ||
        (r.tf || '').toLowerCase().includes(search) ||
        (r.b || '').toLowerCase().includes(search) ||
        (r.end || '').toLowerCase().includes(search)
      );
    }

    const key = state.log.sortKey;
    const dir = state.log.sortDir;

    rows.sort((a, b) => {
      let av, bv;
      if (key === 'bo') {
        av = parseInt(a.bo, 10) || 0;
        bv = parseInt(b.bo, 10) || 0;
      } else if (key === 'd') {
        av = a.d + 'T' + (a.h || '');
        bv = b.d + 'T' + (b.h || '');
      } else {
        av = (a[key] || '');
        bv = (b[key] || '');
      }
      if (av < bv) return dir === 'asc' ? -1 : 1;
      if (av > bv) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / state.log.pageSize));
    if (state.log.page > totalPages) state.log.page = totalPages;

    const start = (state.log.page - 1) * state.log.pageSize;
    const pageRows = rows.slice(start, start + state.log.pageSize);
    const tbody = document.getElementById('logBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!pageRows.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="padding:30px; text-align:center; color:var(--text-dim);">Nenhuma ocorrência encontrada para os filtros atuais.</td></tr>`;
    } else {
      const frag = document.createDocumentFragment();
      for (const r of pageRows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="mono">${fmtDateBR(r.d)}</td>
          <td class="mono">${escapeHtml(r.h)}</td>
          <td class="mono">${escapeHtml(r.bo)}</td>
          <td class="tag" title="${escapeHtml(r.tf)}">${escapeHtml(titleCase(r.tf))}</td>
          <td>${escapeHtml(titleCase(r.b))}</td>
          <td>${escapeHtml(titleCase(r.r))}</td>
          <td class="tag" title="${escapeHtml(r.end)}">${escapeHtml(titleCase(r.end))}</td>
        `;
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
    }

    document.getElementById('pagerInfo').textContent = total ? `${fmtInt(start + 1)}–${fmtInt(Math.min(start + pageRows.length, total))} de ${fmtInt(total)}` : '0 de 0';
    document.getElementById('pagerPrev').disabled = state.log.page <= 1;
    document.getElementById('pagerNext').disabled = state.log.page >= totalPages;

    document.querySelectorAll('.logtable th[data-sort]').forEach(th => {
      const k = th.dataset.sort;
      th.classList.toggle('active', k === key);
      th.classList.toggle('asc', k === key && dir === 'asc');
      th.classList.toggle('desc', k === key && dir === 'desc');
    });
  },

  exportCsv() {
    const rows = state.filtered;
    if (!rows.length) {
      UI.showToast('Exportar CSV', 'Nenhum dado para exportar', true);
      return;
    }
    let csv = '\uFEFFData;Hora;BO;Tipo Final;Bairro;Regional;Endereco\r\n';
    for (const r of rows) {
      csv += `${csvEscape(fmtDateBR(r.d))};${csvEscape(r.h)};${csvEscape(r.bo)};${csvEscape(r.tf)};${csvEscape(r.b)};${csvEscape(r.r)};${csvEscape(r.end)}\r\n`;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `ocorrencias_gcm_${todayStamp()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
};

// ============================================================
// 19. DASHBOARD CONTROLLER (ORCHESTRATOR)
// ============================================================

const Dashboard = {
  render() {
    if (state._rendering) return;
    state._rendering = true;

    try {
      const filtered = Filters.apply();

      KPI.render(filtered);
      Timeline.render(filtered);
      Heatmap.render(filtered);

      Ranking.render('tipoRank', filtered, r => r.tf, state.filters.tipos, this.onTipoClick);
      Ranking.render('bairroRank', filtered, r => r.b, state.filters.bairros, this.onBairroClick);

      Natureza.render(filtered);
      MonthTable.render();
      Comparativo.render();
      LogTable.render();

      UI.updateHeader();
      UI.updateTotalPill();
      FilterUI.updateCounts();
    } finally {
      state._rendering = false;
    }
  },

  onTipoClick(name) {
    if (state.filters.tipos !== null && state.filters.tipos.size === 1 && state.filters.tipos.has(name)) {
      state.filters.tipos = null;
    } else {
      state.filters.tipos = new Set([name]);
    }
    FilterUI.syncChecklist('tipo');
    Dashboard.render();
  },

  onBairroClick(name) {
    if (state.filters.bairros !== null && state.filters.bairros.size === 1 && state.filters.bairros.has(name)) {
      state.filters.bairros = null;
    } else {
      state.filters.bairros = new Set([name]);
    }
    FilterUI.syncChecklist('bairro');
    Dashboard.render();
  },

  async refresh() {
    const result = await DataLoader.loadFromGoogleSheets(true);
    if (result) {
      const [minD, maxD] = getDateRange(state.all);
      Filters.setDateRange(minD, maxD);
      document.getElementById('dateFrom').value = minD || '';
      document.getElementById('dateTo').value = maxD || '';
      this.render();
    }
  },

  reset() {
    Filters.reset();
  },

  setGranularity(gran) {
    state.view.granularity = gran;
    document.querySelectorAll('#granCtl button').forEach(b => {
      b.classList.toggle('active', b.dataset.g === gran);
    });
    Timeline.render(state.filtered);
  },

  setLogSort(key) {
    if (state.log.sortKey === key) {
      state.log.sortDir = state.log.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.log.sortKey = key;
      state.log.sortDir = 'desc';
    }
    state.log.page = 1;
    LogTable.render();
  },

  setLogPage(dir) {
    state.log.page += dir;
    LogTable.render();
  },

  setLogSearch(q) {
    state.log.search = q;
    state.log.page = 1;
    LogTable.render();
  }
};

// ============================================================
// 20. INICIALIZAÇÃO DE EVENTOS CONTROLLER
// ============================================================

function initEvents() {
  document.getElementById('btnSync').addEventListener('click', () => Dashboard.refresh());
  document.getElementById('btnSyncModal').addEventListener('click', () => Dashboard.refresh());
  document.getElementById('btnReset').addEventListener('click', () => Dashboard.reset());
  document.getElementById('btnResetFromModal').addEventListener('click', () => Dashboard.reset());

  document.getElementById('btnHistory').addEventListener('click', () => UI.openModal());
  document.getElementById('btnClearFilters').addEventListener('click', () => Dashboard.reset());
  document.getElementById('modalClose').addEventListener('click', () => UI.closeModal());
  window.addEventListener('click', (e) => {
    if (e.target === document.getElementById('uploadModal')) UI.closeModal();
  });

  document.getElementById('dateFrom').addEventListener('change', (e) => {
    state.filters.dateFrom = e.target.value || null;
    Dashboard.render();
  });
  document.getElementById('dateTo').addEventListener('change', (e) => {
    state.filters.dateTo = e.target.value || null;
    Dashboard.render();
  });
  document.getElementById('regionalSelect').addEventListener('change', (e) => {
    state.filters.regional = e.target.value || '';
    Dashboard.render();
  });

  document.getElementById('bairroOficialToggle').addEventListener('change', (e) => {
    document.getElementById('bairroOficialWrap').classList.toggle('active', e.target.checked);
    FilterUI.setBairroOficial(e.target.checked);
  });

  document.querySelectorAll('#granCtl button').forEach(b => {
    b.addEventListener('click', () => Dashboard.setGranularity(b.dataset.g));
  });

  document.querySelectorAll('.msel-btn[data-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = btn.closest('.msel');
      const open = p.classList.contains('open');
      document.querySelectorAll('.msel.open').forEach(m => m.classList.remove('open'));
      if (!open) p.classList.add('open');
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.msel.open').forEach(m => m.classList.remove('open'));
  });

  document.querySelectorAll('.msel-panel').forEach(p => {
    p.addEventListener('click', e => e.stopPropagation());
  });

  document.getElementById('tipoList').addEventListener('change', (e) => {
    if (e.target.matches('input[type=checkbox]')) {
      FilterUI.toggleItem('tipo', e.target.dataset.name, e.target.checked);
    }
  });

  document.getElementById('bairroList').addEventListener('change', (e) => {
    if (e.target.matches('input[type=checkbox]')) {
      FilterUI.toggleItem('bairro', e.target.dataset.name, e.target.checked);
    }
  });

  document.getElementById('tipoSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#tipoList .msel-item').forEach(row => {
      row.style.display = row.dataset.name.includes(q) ? 'flex' : 'none';
    });
  });

  document.getElementById('bairroSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#bairroList .msel-item').forEach(row => {
      row.style.display = row.dataset.name.includes(q) ? 'flex' : 'none';
    });
  });

  document.querySelectorAll('.msel-actions').forEach(box => {
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      FilterUI.setAll(btn.dataset.target, btn.dataset.act);
    });
  });

  const logSearch = document.getElementById('logSearch');
  logSearch.addEventListener('input', debounce((e) => {
    Dashboard.setLogSearch(e.target.value);
  }, 250));

  document.querySelectorAll('.logtable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      Dashboard.setLogSort(th.dataset.sort);
    });
  });

  document.getElementById('pagerPrev').addEventListener('click', () => Dashboard.setLogPage(-1));
  document.getElementById('pagerNext').addEventListener('click', () => Dashboard.setLogPage(1));
  document.getElementById('btnExportCsv').addEventListener('click', LogTable.exportCsv);
}

// ============================================================
// 21. INICIALIZAÇÃO
// ============================================================

async function init() {
  if (window.Chart) {
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = '#a9b8c4';
  }

  const loaded = await DataLoader.loadFromGoogleSheets(false);

  if (loaded) {
    const [minD, maxD] = getDateRange(state.all);
    Filters.setDateRange(minD, maxD);
    document.getElementById('dateFrom').value = minD || '';
    document.getElementById('dateTo').value = maxD || '';
  }

  initEvents();
  Dashboard.render();

  document.getElementById('footerInfo').textContent =
    'Painel de Ocorrências · dados sincronizados via Google Sheets';
}

window.addEventListener('DOMContentLoaded', init);
