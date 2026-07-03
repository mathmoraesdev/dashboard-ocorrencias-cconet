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
    natureza: null
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
  lastSync: null
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

    // dd/mm/yyyy ou dd/mm/yyyy hh:mm
    if (datePart.includes('/')) {
      const p = datePart.split('/');
      if (p.length === 3) {
        if (p[0].length === 4) return `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
        return `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
      }
    }

    // yyyy-mm-dd
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
    return `${rec.ano}-${rec.bo}`;
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

      // Remover BOM
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
        UI.showToast('Dados atualizados', `${fmtInt(state.all.length)} registros carregados`, false);
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
    const byMonth = {};
    for (const rec of records) {
      const mk = rec.d.slice(0, 7);
      (byMonth[mk] = byMonth[mk] || []).push(rec);
    }

    let added = 0, updated = 0, noKeyCount = 0;

    for (const mk of Object.keys(byMonth)) {
      const existingArr = state.monthBuckets[mk] ? state.monthBuckets[mk].slice() : [];
      const map = new Map();
      for (const r of existingArr) {
        map.set(Parser.buildKey(r), r);
      }

      for (const rec of byMonth[mk]) {
        let key;
        if (rec.bo) {
          key = Parser.buildKey(rec);
        } else {
          noKeyCount++;
          key = `${mk}-nobo-${noKeyCount}-${Math.random().toString(36).slice(2, 7)}`;
        }

        if (map.has(key)) {
          const prev = map.get(key);
          const same = prev.d === rec.d && prev.h === rec.h &&
            prev.tf === rec.tf && prev.b === rec.b && prev.r === rec.r;
          if (!same) updated++;
        } else {
          added++;
        }
        map.set(key, rec);
      }

      state.monthBuckets[mk] = Array.from(map.values());
    }

    // Reconstruir array all
    this.rebuildAll();

    // Registrar no histórico
    const entry = {
      filename: 'Google Sheets',
      timestamp: new Date().toISOString(),
      added,
      updated,
      months: Object.keys(byMonth).sort()
    };
    state.uploadLog = [entry, ...state.uploadLog].slice(0, 20);
    state.lastSync = new Date().toISOString();

    // Atualizar metadados
    Metadata.refresh();

    return { added, updated };
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
    caches.bairroCounts = groupBy(state.all, r => r.b);
    caches.naturezaCounts = groupBy(state.all, r => r.nat);

    FilterUI.refreshOptions();
  }
};

// ============================================================
// 8. FILTROS
// ============================================================

const Filters = {
  apply() {
    const { dateFrom, dateTo, tipos, bairros, regional, natureza } = state.filters;

    state.filtered = state.all.filter(r => {
      if (dateFrom && r.d < dateFrom) return false;
      if (dateTo && r.d > dateTo) return false;
      if (tipos && !tipos.has(r.tf)) return false;
      if (bairros && !bairros.has(r.b)) return false;
      if (regional && r.r !== regional) return false;
      if (natureza && r.nat !== natureza) return false;
      return true;
    });

    return state.filtered;
  },

  applyIgnoringDate() {
    const { tipos, bairros, regional, natureza } = state.filters;

    return state.all.filter(r => {
      if (tipos && !tipos.has(r.tf)) return false;
      if (bairros && !bairros.has(r.b)) return false;
      if (regional && r.r !== regional) return false;
      if (natureza && r.nat !== natureza) return false;
      return true;
    });
  },

  reset() {
    const [minD, maxD] = getDateRange(state.all);
    state.filters.dateFrom = minD;
    state.filters.dateTo = maxD;
    state.filters.tipos = null;
    state.filters.bairros = null;
    state.filters.regional = '';
    state.filters.natureza = null;

    // Reset UI
    document.getElementById('dateFrom').value = minD || '';
    document.getElementById('dateTo').value = maxD || '';
    document.getElementById('regionalSelect').value = '';

    FilterUI.refreshChecklists();
  },

  setDateRange(from, to) {
    state.filters.dateFrom = from;
    state.filters.dateTo = to;
  }
};

// ============================================================
// 9. UI - FILTERS
// ============================================================

const FilterUI = {
  refreshOptions() {
    // Regional select
    const regSel = document.getElementById('regionalSelect');
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

    // Rebuild checklists
    this.refreshChecklists();
  },

  refreshChecklists() {
    this.buildList('tipoList', caches.tipoCounts, 'tipo');
    this.buildList('bairroList', caches.bairroCounts, 'bairro');
    this.updateCounts();
  },

  buildList(listId, countsMap, target) {
    const container = document.getElementById(listId);
    const activeSet = target === 'tipo' ? state.filters.tipos : state.filters.bairros;
    const sorted = Array.from(countsMap.entries()).sort((a, b) => b[1] - a[1]);

    const frag = document.createDocumentFragment();
    for (const [name, count] of sorted) {
      const row = document.createElement('label');
      row.className = 'msel-item';
      row.dataset.name = name.toLowerCase();

      const checked = !activeSet || activeSet.has(name);
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

    const tipoSet = state.filters.tipos;
    const bairroSet = state.filters.bairros;

    tipoEl.textContent = tipoSet === null ? 'todos' : `${tipoSet.size} sel.`;
    bairroEl.textContent = bairroSet === null ? 'todos' : `${bairroSet.size} sel.`;
  },

  toggleItem(target, name, checked) {
    const key = target === 'tipo' ? 'tipos' : 'bairros';
    const allNames = new Set((target === 'tipo' ? caches.tipoCounts : caches.bairroCounts).keys());

    let cur = state.filters[key];
    cur = cur === null ? new Set(allNames) : new Set(cur);

    if (checked) cur.add(name);
    else cur.delete(name);

    state.filters[key] = (cur.size === allNames.size) ? null : cur;

    this.updateCounts();
    Dashboard.render();
  },

  setAll(target, mode) {
    const key = target === 'tipo' ? 'tipos' : 'bairros';
    state.filters[key] = (mode === 'all') ? null : new Set();

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
        <span class="c">+${fmtInt(entry.added || 0)} / ~${fmtInt(entry.updated || 0)}</span>
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
    document.getElementById('kpiAvgSub').textContent = days > 0 ? `em ${fmtInt(days)} dias` : 'ocorrências / dia';

    // Horário de pico
    const hourCounts = Array(24).fill(0);
    for (const r of filtered) {
      if (r.h) {
        const hh = parseInt(r.h.slice(0, 2), 10);
        if (!isNaN(hh)) hourCounts[hh]++;
      }
    }

    let peakH = 0, peakV = -1;
    for (let h = 0; h < 24; h++) {
      if (hourCounts[h] > peakV) { peakV = hourCounts[h]; peakH = h; }
    }
    document.getElementById('kpiPeakHour').textContent = total ? `${String(peakH).padStart(2, '0')}:00` : '—';
    document.getElementById('kpiPeakHourSub').textContent = total ? `${fmtInt(peakV)} ocorrências` : '—';

    // Top bairro
    const bCounts = groupBy(filtered, r => r.b);
    const bSorted = Array.from(bCounts.entries()).sort((a, b) => b[1] - a[1]);
    document.getElementById('kpiTopBairro').textContent = bSorted.length ? titleCase(bSorted[0][0]) : '—';
    document.getElementById('kpiTopBairroSub').textContent = bSorted.length ? `${fmtInt(bSorted[0][1])} ocorrências` : '—';

    // Top tipo
    const tCounts = groupBy(filtered, r => r.tf);
    const tSorted = Array.from(tCounts.entries()).sort((a, b) => b[1] - a[1]);
    const topTipoEl = document.getElementById('kpiTopTipo');
    topTipoEl.textContent = tSorted.length ? titleCase(tSorted[0][0]) : '—';
    topTipoEl.title = tSorted.length ? tSorted[0][0] : '';
    document.getElementById('kpiTopTipoSub').textContent = tSorted.length ? `${fmtInt(tSorted[0][1])} ocorrências` : '—';
  }
};

// ============================================================
// 12. TIMELINE RENDERER
// ============================================================

const Timeline = {
  render(filtered) {
    const gran = state.view.granularity;
    const ctx = document.getElementById('timelineChart').getContext('2d');

    let labels, dataPoints, maPoints = null, type = 'line';

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

    if (chartInstances.timeline) {
      chartInstances.timeline.destroy();
    }

    chartInstances.timeline = new Chart(ctx, {
      type,
      data: { labels, datasets },
      options: this.chartOptions()
    });
  },

  buildDailySeries(filtered, fromISO, toISO) {
    if (!fromISO || !toISO || fromISO > toISO) return [];

    const counts = groupBy(filtered, r => r.d);
    const days = [];
    let cur = parseISODate(fromISO);
    const end = parseISODate(toISO);
    let guard = 0;

    while (cur <= end && guard < 4000) {
      const iso = toISODate(cur);
      days.push({ d: iso, c: counts.get(iso) || 0 });
      cur = addDays(cur, 1);
      guard++;
    }

    return days;
  },

  chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#a9b8c4',
            boxWidth: 10,
            font: { family: "'Inter', sans-serif", size: 11 }
          }
        },
        tooltip: {
          backgroundColor: '#0a1218',
          borderColor: '#24333f',
          borderWidth: 1,
          titleColor: '#e7edf2',
          bodyColor: '#e7edf2',
          padding: 10,
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 }
        }
      },
      scales: {
        x: {
          grid: { color: '#1c2a35', drawTicks: false },
          ticks: {
            color: '#6f8190',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            maxRotation: 0,
            maxTicksLimit: 14
          }
        },
        y: {
          grid: { color: '#1c2a35' },
          ticks: {
            color: '#6f8190',
            font: { family: "'JetBrains Mono', monospace", size: 10 }
          },
          beginAtZero: true
        }
      }
    };
  }
};

// ============================================================
// 13. HEATMAP RENDERER
// ============================================================

const Heatmap = {
  render(filtered) {
    const grid = document.getElementById('heatGrid');
    grid.innerHTML = '';

    // Cabeçalho com horas
    grid.appendChild(document.createElement('div'));
    for (let h = 0; h < 24; h++) {
      const lbl = document.createElement('div');
      lbl.className = 'heat-hourlabel';
      lbl.textContent = (h % 3 === 0) ? String(h).padStart(2, '0') : '';
      grid.appendChild(lbl);
    }

    // Contar ocorrências por dia da semana e hora
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

    // Renderizar células
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
          this.showTooltip(e, `${WEEKDAYS_PT[d]} ${String(h).padStart(2, '0')}h — <b>${fmtInt(v)}</b> ocorrência(s)`);
        });
        cell.addEventListener('mouseleave', this.hideTooltip);
        grid.appendChild(cell);
      }
    }

    // Estatísticas
    this.renderStats(counts, filtered);
  },

  getColor(v, max) {
    if (max <= 0 || v <= 0) return 'var(--surface-2)';
    const t = v / max;
    const stops = [
      [0.0, CONFIG.HEATMAP_COLORS[0]],
      [0.35, CONFIG.HEATMAP_COLORS[1]],
      [0.65, CONFIG.HEATMAP_COLORS[2]],
      [0.85, CONFIG.HEATMAP_COLORS[3]],
      [1.0, CONFIG.HEATMAP_COLORS[4]]
    ];

    for (let i = 0; i < stops.length - 1; i++) {
      const [t0, c0] = stops[i];
      const [t1, c1] = stops[i + 1];
      if (t >= t0 && t <= t1) {
        const f = (t - t0) / (t1 - t0);
        const c = c0.map((v0, idx) => Math.round(v0 + f * (c1[idx] - v0)));
        return `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    return 'rgb(232,168,74)';
  },

  renderStats(counts, filtered) {
    let peakVal = -1, peakD = 0, peakH = 0;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        if (counts[d][h] > peakVal) {
          peakVal = counts[d][h];
          peakD = d;
          peakH = h;
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

  showTooltip(e, html) {
    const el = document.getElementById('floatTooltip');
    el.innerHTML = html;
    el.style.display = 'block';

    let x = e.clientX + 14, y = e.clientY + 14;
    const vw = window.innerWidth, vh = window.innerHeight;
    if (x + 180 > vw) x = e.clientX - 190;
    if (y + 60 > vh) y = e.clientY - 60;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  },

  hideTooltip() {
    document.getElementById('floatTooltip').style.display = 'none';
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
    container.innerHTML = '';

    if (!sorted.length) {
      container.innerHTML = this.emptyState();
      return;
    }

    const top = sorted.slice(0, topN);
    const restSum = sorted.slice(topN).reduce((s, e) => s + e[1], 0);
    const maxVal = top.length ? top[0][1] : 0;

    for (const [name, count] of top) {
      const row = document.createElement('div');
      row.className = 'rankbar-row' + (activeSet && activeSet.has(name) && activeSet.size === 1 ? ' active' : '');
      row.innerHTML = `
        <div class="rankbar-top">
          <span class="name" title="${escapeHtml(name)}">${escapeHtml(titleCase(name))}</span>
          <span class="val">${fmtInt(count)}</span>
        </div>
        <div class="rankbar-track">
          <div class="rankbar-fill" style="width:${maxVal ? (count / maxVal * 100) : 0}%"></div>
        </div>
      `;
      row.addEventListener('click', () => onClick(name));
      container.appendChild(row);
    }

    if (restSum > 0) {
      const row = document.createElement('div');
      row.className = 'rankbar-row';
      row.innerHTML = `
        <div class="rankbar-top">
          <span class="name" style="color:var(--text-dim)">Outros (${sorted.length - topN})</span>
          <span class="val">${fmtInt(restSum)}</span>
        </div>
        <div class="rankbar-track">
          <div class="rankbar-fill" style="width:${maxVal ? (restSum / maxVal * 100) : 0}%; opacity:0.4"></div>
        </div>
      `;
      container.appendChild(row);
    }
  },

  emptyState() {
    return `<div class="empty-state">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="12" r="9"/>
        <path d="M9 9l6 6M15 9l-6 6"/>
      </svg>
      <p>Nenhum dado para os filtros atuais.</p>
    </div>`;
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
        datasets: [{
          data,
          backgroundColor: colors,
          borderColor: '#141f2a',
          borderWidth: 2
        }]
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

    // Legend
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
        <span class="lval">${total ? Math.round(data[i] / total * 100) : 0}%</span>
      `;
      row.addEventListener('click', () => this.onClick(lab));
      legend.appendChild(row);
    });
  },

  onClick(name) {
    state.filters.natureza = (state.filters.natureza === name) ? null : name;
    Dashboard.render();
  }
};

// ============================================================
// 16. MONTH TABLE RENDERER
// ============================================================

const MonthTable = {
  render() {
    const filtered = Filters.applyIgnoringDate();
    const byMonth = {};
    for (const r of filtered) {
      const mk = r.d.slice(0, 7);
      (byMonth[mk] = byMonth[mk] || []).push(r);
    }

    const keys = Object.keys(byMonth).sort();
    const tbody = document.getElementById('monthTableBody');
    tbody.innerHTML = '';
    document.getElementById('monthHint').textContent = keys.length ? `${keys.length} mês(es)` : '';

    if (!keys.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-dim); padding:20px;">Sem dados</td></tr>`;
      return;
    }

    let prevTotal = null;
    for (const mk of keys) {
      const arr = byMonth[mk];
      const total = arr.length;
      const tfCounts = groupBy(arr, r => r.tf);
      const topTf = Array.from(tfCounts.entries()).sort((a, b) => b[1] - a[1])[0];

      let deltaHtml = '<span style="color:var(--text-dim)">—</span>';
      if (prevTotal !== null && prevTotal > 0) {
        const pct = (total - prevTotal) / prevTotal * 100;
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
    const filtered = state.filtered;
    const allData = state.all;
    const hint = document.getElementById('compHint');

    // Detectar anos presentes nos dados
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
      if (chartInstances.compMonth) { chartInstances.compMonth.destroy(); chartInstances.compMonth = null; }
      if (chartInstances.compHour) { chartInstances.compHour.destroy(); chartInstances.compHour = null; }
      return;
    }

    const anoBase = anosArray[0];
    const anoCurr = anosArray[anosArray.length - 1];
    const mesesPresentes = new Set();
    for (const r of allData) {
      if (r.ano === anoCurr) {
        mesesPresentes.add(monthOf(r.d));
      }
    }

    const rangeLbl = this.monthRangeLabel(mesesPresentes);
    hint.textContent = `mesmo período (${rangeLbl}) comparado entre ${anoBase} e ${anoCurr}`;

    // Atualizar labels
    document.getElementById('legendYearBase').textContent = anoBase;
    document.getElementById('legendYearCurr').textContent = anoCurr;
    document.getElementById('tipoCompYearsLabel').textContent = `${anoBase} vs ${anoCurr}`;
    document.getElementById('bairroCompYearsLabel').textContent = `${anoBase} vs ${anoCurr}`;
    document.getElementById('hourCompYearsLabel').textContent = `${anoBase} vs ${anoCurr}`;

    // Dados filtrados por período
    const dataBase = allData.filter(r =>
      r.ano === anoBase && mesesPresentes.has(monthOf(r.d))
    );
    const dataCurr = allData.filter(r =>
      r.ano === anoCurr && mesesPresentes.has(monthOf(r.d))
    );

    const totalBase = dataBase.length;
    const totalCurr = dataCurr.length;

    // KPIs
    const delta = totalBase > 0 ? ((totalCurr - totalBase) / totalBase * 100) : null;
    const kpisHtml = [
      this.kpiCell(`${anoBase} · completo`, fmtInt(allData.filter(r => r.ano === anoBase).length), 'ano completo'),
      this.kpiCell(`${anoBase} · ${rangeLbl}`, fmtInt(totalBase), 'mesmo período'),
      this.kpiCell(`${anoCurr} · ${rangeLbl}`, fmtInt(totalCurr), 'dados carregados'),
      this.kpiCell('Variação', delta === null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`,
        'base vs atual', delta === null ? '' : (delta >= 0 ? 'delta-up' : 'delta-down'))
    ].join('');
    document.getElementById('compKpis').innerHTML = kpisHtml;

    // Gráfico mensal
    this.renderMonthChart(dataBase, dataCurr, anoBase, anoCurr, mesesPresentes);

    // Rankings
    this.renderCompRank('compTipoList',
      groupBy(dataCurr, r => r.tf),
      groupBy(dataBase, r => r.tf)
    );
    this.renderCompRank('compBairroList',
      groupBy(dataCurr, r => r.b),
      groupBy(dataBase, r => r.b)
    );

    // Distribuição horária
    this.renderHourChart(dataBase, dataCurr, anoBase, anoCurr);
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
          {
            label: String(anoBase),
            data: dataBaseArr,
            backgroundColor: 'rgba(232,168,74,0.55)',
            borderRadius: 3,
            borderWidth: 0,
            maxBarThickness: 26
          },
          {
            label: String(anoCurr),
            data: dataCurrArr,
            backgroundColor: 'rgba(63,184,171,0.85)',
            borderRadius: 3,
            borderWidth: 0,
            maxBarThickness: 26
          }
        ]
      },
      options: this.chartOptions()
    });
  },

  renderCompRank(containerId, countsCurr, countsBase, topN = 8) {
    const container = document.getElementById(containerId);
    const sorted = Array.from(countsCurr.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN);

    if (!sorted.length) {
      container.innerHTML = Ranking.emptyState();
      return;
    }

    const maxVal = Math.max(...sorted.map(([name, c]) => Math.max(c, countsBase.get(name) || 0)), 1);
    let html = '';

    for (const [name, cCurr] of sorted) {
      const cBase = countsBase.get(name) || 0;
      const delta = cBase > 0 ? ((cCurr - cBase) / cBase * 100) : (cCurr > 0 ? null : 0);

      let deltaHtml = '<span class="delta">—</span>';
      if (delta === null && cCurr > 0) {
        deltaHtml = '<span class="delta delta-new">novo</span>';
      } else if (delta !== null) {
        const sign = delta >= 0 ? '+' : '';
        const cls = delta >= 0 ? 'delta-up' : 'delta-down';
        deltaHtml = `<span class="delta ${cls}">${sign}${delta.toFixed(0)}%</span>`;
      }

      html += `
        <div class="comp-row">
          <div class="comp-row-head">
            <span class="name" title="${escapeHtml(name)}">${escapeHtml(titleCase(name))}</span>
            ${deltaHtml}
          </div>
          <div class="comp-bars">
            <div class="comp-bar-line">
              <span class="tag">${Object.keys(state.meta.regionais).length > 0 ? 'base' : '—'}</span>
              <div class="comp-bar-track"><div class="comp-bar-fill y25" style="width:${(cBase / maxVal * 100)}%"></div></div>
              <span class="val">${fmtInt(cBase)}</span>
            </div>
            <div class="comp-bar-line">
              <span class="tag">atual</span>
              <div class="comp-bar-track"><div class="comp-bar-fill y26" style="width:${(cCurr / maxVal * 100)}%"></div></div>
              <span class="val">${fmtInt(cCurr)}</span>
            </div>
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  },

  renderHourChart(dataBase, dataCurr, anoBase, anoCurr) {
    const hcBase = Array(24).fill(0), hcCurr = Array(24).fill(0);

    for (const r of dataBase) {
      if (r.h) {
        const hh = parseInt(r.h.slice(0, 2), 10);
        if (!isNaN(hh)) hcBase[hh]++;
      }
    }
    for (const r of dataCurr) {
      if (r.h) {
        const hh = parseInt(r.h.slice(0, 2), 10);
        if (!isNaN(hh)) hcCurr[hh]++;
      }
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
          {
            label: String(anoBase),
            data: pctBase,
            borderColor: '#e8a84a',
            backgroundColor: 'rgba(232,168,74,0.08)',
            borderWidth: 1.5,
            borderDash: [4, 3],
            pointRadius: 0,
            tension: 0.35,
            fill: false
          },
          {
            label: String(anoCurr),
            data: pctCurr,
            borderColor: '#3fb8ab',
            backgroundColor: 'rgba(63,184,171,0.12)',
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.35,
            fill: true
          }
        ]
      },
      options: this.chartOptions()
    });
  },

  chartOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#a9b8c4',
            boxWidth: 10,
            font: { family: "'Inter', sans-serif", size: 11 }
          }
        },
        tooltip: {
          backgroundColor: '#0a1218',
          borderColor: '#24333f',
          borderWidth: 1,
          titleColor: '#e7edf2',
          bodyColor: '#e7edf2',
          padding: 10,
          titleFont: { family: "'JetBrains Mono', monospace", size: 11 },
          bodyFont: { family: "'JetBrains Mono', monospace", size: 11 }
        }
      },
      scales: {
        x: {
          grid: { color: '#1c2a35', drawTicks: false },
          ticks: {
            color: '#6f8190',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            maxTicksLimit: 24
          }
        },
        y: {
          grid: { color: '#1c2a35' },
          ticks: {
            color: '#6f8190',
            font: { family: "'JetBrains Mono', monospace", size: 10 },
            callback: v => v + '%'
          },
          beginAtZero: true
        }
      }
    };
  }
};

// ============================================================
// 18. LOG TABLE RENDERER
// ============================================================

const LogTable = {
  render() {
    let rows = state.filtered;
    const q = state.log.search.trim().toLowerCase();

    if (q) {
      rows = rows.filter(r =>
        `${r.b} ${r.tf} ${r.end} ${r.r} ${r.bo}`.toLowerCase().includes(q)
      );
    }

    // Ordenação
    const key = state.log.sortKey;
    const dir = state.log.sortDir;
    rows = rows.slice().sort((a, b) => {
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

    document.getElementById('pagerInfo').textContent = total ?
      `${fmtInt(start + 1)}–${fmtInt(Math.min(start + pageRows.length, total))} de ${fmtInt(total)}` :
      '0 de 0';

    document.getElementById('pagerPrev').disabled = state.log.page <= 1;
    document.getElementById('pagerNext').disabled = state.log.page >= totalPages;

    // Indicadores de ordenação
    document.querySelectorAll('.logtable th[data-sort]').forEach(th => {
      const k = th.dataset.sort;
      const arrow = th.querySelector('.arrow');
      arrow.textContent = (k === key) ? (dir === 'asc' ? '↑' : '↓') : '';
    });
  },

  exportCsv() {
    const rows = state.filtered;
    if (!rows.length) {
      UI.showToast('Nenhum dado', 'Não há registros para exportar.', true);
      return;
    }

    const headers = ['Data', 'Hora', 'BO', 'Tipo Final', 'Natureza', 'Bairro', 'Regional', 'Endereço'];
    const lines = [headers.join(';')];

    for (const r of rows) {
      lines.push([
        fmtDateBR(r.d),
        r.h,
        r.bo,
        csvEscape(r.tf),
        csvEscape(r.nat),
        csvEscape(r.b),
        csvEscape(r.r),
        csvEscape(r.end)
      ].join(';'));
    }

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ocorrencias_filtradas_${todayStamp()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
};

// ============================================================
// 19. DASHBOARD - ORQUESTRADOR PRINCIPAL
// ============================================================

const Dashboard = {
  render() {
    // 1. Aplicar filtros
    const filtered = Filters.apply();

    // 2. Renderizar todos os componentes com os dados filtrados
    KPI.render(filtered);
    Timeline.render(filtered);
    Heatmap.render(filtered);

    // Rankings
    Ranking.render('tipoRank', filtered, r => r.tf, state.filters.tipos, this.onTipoClick);
    Ranking.render('bairroRank', filtered, r => r.b, state.filters.bairros, this.onBairroClick);

    // Natureza e tabela mensal
    Natureza.render(filtered);
    MonthTable.render();

    // Comparativo (usa todos os dados, não apenas filtrados por data)
    Comparativo.render();

    // Log
    LogTable.render();

    // Header
    UI.updateHeader();
    UI.updateTotalPill();

    // Atualizar contadores dos filtros
    FilterUI.updateCounts();
  },

  onTipoClick(name) {
    if (state.filters.tipos && state.filters.tipos.size === 1 && state.filters.tipos.has(name)) {
      state.filters.tipos = null;
    } else {
      state.filters.tipos = new Set([name]);
    }
    FilterUI.syncChecklist('tipo');
    this.render();
  },

  onBairroClick(name) {
    if (state.filters.bairros && state.filters.bairros.size === 1 && state.filters.bairros.has(name)) {
      state.filters.bairros = null;
    } else {
      state.filters.bairros = new Set([name]);
    }
    FilterUI.syncChecklist('bairro');
    this.render();
  },

  async refresh() {
    const result = await DataLoader.loadFromGoogleSheets(true);
    if (result) {
      // Definir data range inicial
      const [minD, maxD] = getDateRange(state.all);
      Filters.setDateRange(minD, maxD);
      document.getElementById('dateFrom').value = minD || '';
      document.getElementById('dateTo').value = maxD || '';
      this.render();
    }
  },

  reset() {
    Filters.reset();
    FilterUI.refreshChecklists();
    this.render();
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
      state.log.sortDir = 'asc';
    }
    LogTable.render();
  },

  setLogPage(delta) {
    state.log.page += delta;
    LogTable.render();
  },

  setLogSearch(query) {
    state.log.search = query;
    state.log.page = 1;
    LogTable.render();
  }
};

// ============================================================
// 20. EVENTOS E INICIALIZAÇÃO
// ============================================================

function initEvents() {
  // Sync
  document.getElementById('btnSync').addEventListener('click', () => Dashboard.refresh());
  document.getElementById('btnSyncModal').addEventListener('click', () => Dashboard.refresh());

  // Modal
  document.getElementById('btnHistory').addEventListener('click', UI.openModal);
  document.getElementById('modalClose').addEventListener('click', UI.closeModal);
  document.getElementById('uploadModal').addEventListener('click', (e) => {
    if (e.target.id === 'uploadModal') UI.closeModal();
  });

  // Reset
  document.getElementById('btnReset').addEventListener('click', Dashboard.reset);
  document.getElementById('btnResetFromModal').addEventListener('click', Dashboard.reset);

  // Date filters
  document.getElementById('dateFrom').addEventListener('change', (e) => {
    state.filters.dateFrom = e.target.value;
    Dashboard.render();
  });
  document.getElementById('dateTo').addEventListener('change', (e) => {
    state.filters.dateTo = e.target.value;
    Dashboard.render();
  });

  // Regional
  document.getElementById('regionalSelect').addEventListener('change', (e) => {
    state.filters.regional = e.target.value;
    Dashboard.render();
  });

  // Clear filters
  document.getElementById('btnClearFilters').addEventListener('click', Dashboard.reset);

  // Multiselect toggles
  document.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.toggle;
      const el = document.getElementById(id);
      const wasOpen = el.classList.contains('open');
      document.querySelectorAll('.msel.open').forEach(m => m.classList.remove('open'));
      if (!wasOpen) el.classList.add('open');
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.msel.open').forEach(m => m.classList.remove('open'));
  });

  document.querySelectorAll('.msel-panel').forEach(p => {
    p.addEventListener('click', e => e.stopPropagation());
  });

  // Multiselect items
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

  // Multiselect search
  document.getElementById('tipoSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#tipoList .msel-item').forEach(row => {
      row.style.display = row.dataset.name.includes(q) ? '' : 'none';
    });
  });

  document.getElementById('bairroSearch').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('#bairroList .msel-item').forEach(row => {
      row.style.display = row.dataset.name.includes(q) ? '' : 'none';
    });
  });

  // Multiselect actions
  document.querySelectorAll('.msel-actions button').forEach(btn => {
    btn.addEventListener('click', () => {
      FilterUI.setAll(btn.dataset.target, btn.dataset.act);
    });
  });

  // Granularity
  document.querySelectorAll('#granCtl button').forEach(btn => {
    btn.addEventListener('click', () => {
      Dashboard.setGranularity(btn.dataset.g);
    });
  });

  // Log search (debounced)
  document.getElementById('logSearch').addEventListener('input', debounce((e) => {
    Dashboard.setLogSearch(e.target.value);
  }, 220));

  // Log sorting
  document.querySelectorAll('.logtable th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      Dashboard.setLogSort(th.dataset.sort);
    });
  });

  // Log pagination
  document.getElementById('pagerPrev').addEventListener('click', () => Dashboard.setLogPage(-1));
  document.getElementById('pagerNext').addEventListener('click', () => Dashboard.setLogPage(1));

  // Export CSV
  document.getElementById('btnExportCsv').addEventListener('click', LogTable.exportCsv);
}

// ============================================================
// 21. INICIALIZAÇÃO
// ============================================================

async function init() {
  // Configurar Chart.js
  if (window.Chart) {
    Chart.defaults.font.family = "'Inter', sans-serif";
    Chart.defaults.color = '#a9b8c4';
  }

  // Carregar dados da planilha
  const loaded = await DataLoader.loadFromGoogleSheets(false);

  if (loaded) {
    const [minD, maxD] = getDateRange(state.all);
    Filters.setDateRange(minD, maxD);
    document.getElementById('dateFrom').value = minD || '';
    document.getElementById('dateTo').value = maxD || '';
  }

  // Renderizar dashboard
  Dashboard.render();

  // Registrar eventos
  initEvents();

  // Footer
  document.getElementById('footerInfo').textContent =
    'Painel de Ocorrências · dados sincronizados via Google Sheets';
}

// Iniciar quando o DOM estiver pronto
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  init();
} else {
  document.addEventListener('DOMContentLoaded', init);
}
